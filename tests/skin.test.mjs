// Offline tests. No network, no API key, no credits.
// NOTE: response fixtures below are ASSUMED shapes (official schema unverified);
// they test our handling logic, not YouCam's real output.
import test from "node:test";
import assert from "node:assert/strict";

import { AuditLog, safeCode } from "../lib/organos-audit.ts";
import { preflight, readImageInfo } from "../lib/organos-image.ts";
import { parseResult } from "../lib/organos-results.ts";
import { YoucamClient, validateActions, YoucamError, DEFAULT_ACTIONS } from "../lib/organos-youcam.ts";

const KEY = "TEST_SECRET_KEY_123";
const PRESIGNED = "https://upload.example.test/signed?X-Amz-Signature=abc123";

function fakeJpeg(w, h) {
  const b = new Uint8Array(64);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3]);
  return b;
}
function fakePng(w, h) {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** Scripted fetch: records calls, answers by URL suffix/method. */
function scripted(taskResponses, opts = {}) {
  const calls = [];
  let poll = 0;
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? "GET", headers: init.headers ?? {} });
    if (u.endsWith("/file/skin-analysis"))
      return opts.registerResponse ?? json({ data: { files: [{ file_id: "fid1", requests: [{ url: PRESIGNED, method: "PUT", headers: { "Content-Type": "image/jpeg" } }] }] } });
    if (u === PRESIGNED) return new Response(null, { status: opts.uploadStatus ?? 200 });
    if (u.endsWith("/task/skin-analysis") && init.method === "POST") return json({ data: { task_id: "t1" } });
    if (u.includes("/task/skin-analysis/")) return json({ data: taskResponses[Math.min(poll++, taskResponses.length - 1)] });
    if (u.endsWith("/client/credit")) return json({ data: { total: 13 } });
    return new Response("nope", { status: 404 });
  };
  return { f, calls };
}

function client(f, audit, extra = {}) {
  return new YoucamClient({ apiKey: KEY, fetchImpl: f, sleep: async () => {}, ...extra }, audit);
}
const IMG = fakeJpeg(2048, 2730);

// ---- validation ----
test("HD and SD actions cannot be mixed", () => {
  assert.throws(() => validateActions(["hd_pore", "wrinkle"]), (e) => e instanceof YoucamError && e.code === "mixed_hd_sd");
});
test("unknown action rejected, defaults are valid SD", () => {
  assert.throws(() => validateActions(["nope"]), (e) => e.code === "unknown_action");
  assert.doesNotThrow(() => validateActions(DEFAULT_ACTIONS));
});

// ---- image preflight ----
test("reads JPEG and PNG dimensions", () => {
  assert.deepEqual(readImageInfo(fakeJpeg(1031, 1536)).width, 1031);
  assert.equal(readImageInfo(fakePng(800, 600)).height, 600);
  assert.equal(readImageInfo(new Uint8Array([1, 2, 3])), null);
});
test("1031x1536 (the earlier failing image size) is flagged before any paid call", () => {
  const r = preflight(fakeJpeg(1031, 1536));
  assert.ok(r.issues.some((i) => i.code === "short_edge_below_hint" && i.blocking));
});
test("2048x2730 passes preflight", () => {
  assert.equal(preflight(fakeJpeg(2048, 2730)).issues.length, 0);
});

// ---- audit ----
test("safeCode keeps identifiers, drops URLs/keys/prose", () => {
  assert.equal(safeCode("error_src_face_too_small"), "error_src_face_too_small");
  assert.equal(safeCode("https://x.test/a?sig=1"), undefined);
  assert.equal(safeCode("Bearer abc"), undefined);
  assert.equal(safeCode("some long sentence with spaces"), undefined);
});

// ---- the observed failure pattern: every HTTP 200, final task_status error ----
test("HTTP 200 everywhere + task_status=error => failure at task_poll with code, never success", async () => {
  const audit = new AuditLog();
  const { f } = scripted([{ task_status: "running", polling_interval: 1 }, { task_status: "error", error: "error_src_face_too_small" }]);
  const c = client(f, audit);
  const t = await c.registerFile(IMG, "a.jpg", "image/jpeg");
  await c.uploadFile(t, IMG, "image/jpeg");
  const id = await c.createTask(t.fileId, DEFAULT_ACTIONS);
  const res = await c.pollTask(id);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "task_error");
  assert.equal(res.code, "error_src_face_too_small");
  const first = audit.firstFailure();
  assert.equal(first.step, "task_poll");
  assert.equal(first.httpStatus, 200);
  assert.equal(first.code, "error_src_face_too_small");
});

test("success status but no extractable scores is a parse failure, not success", async () => {
  const audit = new AuditLog();
  const { f } = scripted([{ task_status: "success", results: {} }]);
  const res = await client(f, audit).pollTask("t1");
  assert.deepEqual([res.ok, res.reason], [false, "no_scores"]);
});

test("success with ui_score values parses (assumed shape)", () => {
  const r = parseResult({ task_status: "success", results: { wrinkle: { ui_score: 72, raw_score: 10 }, pore: { ui_score: 130 } } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.scores, [{ concern: "wrinkle", uiScore: 72 }, { concern: "pore", uiScore: 100 }]);
});

test("array-shaped output also parses", () => {
  const r = parseResult({ task_status: "success", output: [{ type: "acne", ui_score: 55 }] });
  assert.deepEqual(r.scores, [{ concern: "acne", uiScore: 55 }]);
});

// ---- full happy path + safety ----
test("happy path: pending then success, upload has no Authorization header", async () => {
  const audit = new AuditLog();
  const { f, calls } = scripted([{ task_status: "running" }, { task_status: "success", results: { texture: { ui_score: 80 } } }]);
  const c = client(f, audit);
  const t = await c.registerFile(IMG, "a.jpg", "image/jpeg");
  await c.uploadFile(t, IMG, "image/jpeg");
  const res = await c.pollTask(await c.createTask(t.fileId, DEFAULT_ACTIONS));
  assert.equal(res.ok, true);
  const put = calls.find((x) => x.url === PRESIGNED);
  assert.ok(!Object.keys(put.headers).some((h) => h.toLowerCase() === "authorization"));
  const api = calls.filter((x) => x.url !== PRESIGNED);
  assert.ok(api.every((x) => x.headers.Authorization === `Bearer ${KEY}`));
});

test("audit output never contains the API key or presigned URL", async () => {
  const audit = new AuditLog();
  const { f } = scripted([{ task_status: "error", error: PRESIGNED }]);
  const c = client(f, audit);
  const t = await c.registerFile(IMG, "a.jpg", "image/jpeg");
  await c.uploadFile(t, IMG, "image/jpeg");
  await c.pollTask(await c.createTask(t.fileId, DEFAULT_ACTIONS));
  const dump = JSON.stringify(audit.toJSON());
  assert.ok(!dump.includes(KEY));
  assert.ok(!dump.includes("X-Amz-Signature"));
  assert.ok(!dump.includes("upload.example.test"));
});

// ---- step failures ----
test("upload failure is attributed to file_upload", async () => {
  const audit = new AuditLog();
  const { f } = scripted([], { uploadStatus: 403 });
  const c = client(f, audit);
  const t = await c.registerFile(IMG, "a.jpg", "image/jpeg");
  await assert.rejects(c.uploadFile(t, IMG, "image/jpeg"), (e) => e.step === "file_upload" && e.httpStatus === 403);
  assert.equal(audit.firstFailure().step, "file_upload");
});

test("register returning an unexpected shape fails at file_register", async () => {
  const audit = new AuditLog();
  const { f } = scripted([], { registerResponse: json({ data: {} }) });
  await assert.rejects(client(f, audit).registerFile(IMG, "a.jpg", "image/jpeg"), (e) => e.step === "file_register" && e.code === "unexpected_shape");
});

test("poll timeout is reported, not silently treated as success", async () => {
  const audit = new AuditLog();
  const { f } = scripted([{ task_status: "running", polling_interval: 1 }]);
  await assert.rejects(client(f, audit, { pollBudgetMs: 1500 }).pollTask("t1"), (e) => e.step === "task_poll" && e.code === "poll_timeout");
});

test("free credit check hits only the credit endpoint", async () => {
  const audit = new AuditLog();
  const { f, calls } = scripted([]);
  const data = await client(f, audit).getCredit();
  assert.equal(data.total, 13);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/s2s/v1.0/client/credit"));
});

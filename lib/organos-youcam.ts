// Server-only YouCam Skin Analysis v2.1 client, split into independent steps.
// All network access goes through an injectable `fetch`, so tests never touch the API.
//
// Endpoint sources (not all verified against a live account):
//  - task create/poll: /s2s/v2.1/task/skin-analysis  (official skills + SKIN_AI + perfectcorp-mcp agree)
//  - file register:    /s2s/v2.1/file/skin-analysis  (SKIN_AI, perfectcorp-mcp)
//                      /s2s/v2.0/file                (official skills' generic upload)
//    The handover doc says "/s2s/v2.1/file", which matches neither. Configurable below.
//  - base host: yce-api-01.makeupar.com (official skills snapshot) vs
//               yce-api-01.perfectcorp.com (SKIN_AI). Configurable below.

import { AuditLog, safeCode } from "./organos-audit.ts";
import { classifyStatus, parseResult, type ParsedResult } from "./organos-results.ts";

export const HD_ACTIONS = [
  "hd_redness", "hd_oiliness", "hd_age_spot", "hd_radiance", "hd_moisture", "hd_dark_circle",
  "hd_eye_bag", "hd_droopy_upper_eyelid", "hd_droopy_lower_eyelid", "hd_firmness", "hd_texture",
  "hd_acne", "hd_pore", "hd_wrinkle", "hd_tear_trough", "hd_skin_type",
] as const;

export const SD_ACTIONS = [
  "wrinkle", "droopy_upper_eyelid", "droopy_lower_eyelid", "firmness", "acne", "moisture",
  "eye_bag", "dark_circle_v2", "age_spot", "radiance", "redness", "oiliness", "pore", "texture",
  "tear_trough", "skin_type",
] as const;

/** Default: SD tier, same four concerns as the failed run (cheaper tier: 9 vs 12 units per earlier notes). */
export const DEFAULT_ACTIONS: string[] = ["wrinkle", "pore", "texture", "acne"];

export function validateActions(actions: string[]): void {
  const hd = new Set<string>(HD_ACTIONS);
  const sd = new Set<string>(SD_ACTIONS);
  const unknown = actions.filter((a) => !hd.has(a) && !sd.has(a));
  if (unknown.length) throw new YoucamError("preflight", "unknown_action");
  const hasHd = actions.some((a) => hd.has(a));
  const hasSd = actions.some((a) => sd.has(a));
  if (hasHd && hasSd) throw new YoucamError("preflight", "mixed_hd_sd");
  if (actions.length === 0) throw new YoucamError("preflight", "no_actions");
}

export class YoucamError extends Error {
  constructor(
    public step: "preflight" | "credit_check" | "file_register" | "file_upload" | "task_create" | "task_poll",
    public code: string,
    public httpStatus?: number,
  ) {
    super(`${step}:${code}${httpStatus ? `:${httpStatus}` : ""}`);
  }
}

export type YoucamConfig = {
  apiKey: string;
  baseUrl?: string;
  fileEndpoint?: string;
  taskEndpoint?: string;
  creditEndpoint?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollBudgetMs?: number;
};

export function configFromEnv(env: Record<string, string | undefined> = process.env): YoucamConfig {
  const apiKey = env.YOUCAM_API_KEY;
  if (!apiKey) throw new YoucamError("preflight", "missing_api_key");
  return {
    apiKey,
    baseUrl: env.YOUCAM_BASE_URL,
    fileEndpoint: env.YOUCAM_FILE_ENDPOINT,
  };
}

export class YoucamClient {
  private base: string;
  private fileEp: string;
  private taskEp: string;
  private creditEp: string;
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private budget: number;

  constructor(private cfg: YoucamConfig, private audit: AuditLog) {
    this.base = cfg.baseUrl ?? "https://yce-api-01.makeupar.com";
    this.fileEp = cfg.fileEndpoint ?? "/s2s/v2.1/file/skin-analysis";
    this.taskEp = cfg.taskEndpoint ?? "/s2s/v2.1/task/skin-analysis";
    this.creditEp = cfg.creditEndpoint ?? "/s2s/v1.0/client/credit";
    this.f = cfg.fetchImpl ?? fetch;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.budget = cfg.pollBudgetMs ?? 45_000;
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.apiKey}` };
  }

  /** Free per official skills docs ("0 credits"). Returns the raw `data` object. */
  async getCredit(): Promise<unknown> {
    const res = await this.f(`${this.base}${this.creditEp}`, { headers: this.auth() });
    if (!res.ok) {
      this.audit.record({ step: "credit_check", ok: false, httpStatus: res.status });
      throw new YoucamError("credit_check", "http_error", res.status);
    }
    this.audit.record({ step: "credit_check", ok: true, httpStatus: res.status });
    const body: any = await res.json().catch(() => ({}));
    return body?.data ?? body;
  }

  async registerFile(bytes: Uint8Array, fileName: string, contentType: string) {
    const res = await this.f(`${this.base}${this.fileEp}`, {
      method: "POST",
      headers: { ...this.auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ files: [{ content_type: contentType, file_name: fileName, file_size: bytes.byteLength }] }),
    });
    if (!res.ok) {
      const code = await providerCode(res);
      this.audit.record({ step: "file_register", ok: false, httpStatus: res.status, code });
      throw new YoucamError("file_register", safeCode(code) ?? "http_error", res.status);
    }
    const body: any = await res.json().catch(() => ({}));
    const info = body?.data?.files?.[0];
    const req = info?.requests?.[0];
    if (!info?.file_id || !req?.url) {
      this.audit.record({ step: "file_register", ok: false, httpStatus: res.status, code: "unexpected_shape" });
      throw new YoucamError("file_register", "unexpected_shape", res.status);
    }
    this.audit.record({ step: "file_register", ok: true, httpStatus: res.status });
    return { fileId: String(info.file_id), uploadUrl: String(req.url), method: String(req.method ?? "PUT"), headers: (req.headers ?? { "Content-Type": contentType }) as Record<string, string> };
  }

  async uploadFile(target: { uploadUrl: string; method: string; headers: Record<string, string> }, bytes: Uint8Array, contentType: string) {
    // Presigned URL: no Authorization header. The URL itself is never logged.
    const res = await this.f(target.uploadUrl, {
      method: target.method,
      headers: target.headers,
      body: new Blob([bytes as BlobPart], { type: contentType }),
    });
    this.audit.record({ step: "file_upload", ok: res.ok, httpStatus: res.status });
    if (!res.ok) throw new YoucamError("file_upload", "http_error", res.status);
  }

  async createTask(fileId: string, actions: string[]): Promise<string> {
    validateActions(actions);
    const res = await this.f(`${this.base}${this.taskEp}`, {
      method: "POST",
      headers: { ...this.auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ src_file_id: fileId, dst_actions: actions, format: "json" }),
    });
    if (!res.ok) {
      const code = await providerCode(res);
      this.audit.record({ step: "task_create", ok: false, httpStatus: res.status, code });
      throw new YoucamError("task_create", safeCode(code) ?? "http_error", res.status);
    }
    const body: any = await res.json().catch(() => ({}));
    const id = body?.data?.task_id;
    if (!id) {
      this.audit.record({ step: "task_create", ok: false, httpStatus: res.status, code: "missing_task_id" });
      throw new YoucamError("task_create", "missing_task_id", res.status);
    }
    this.audit.record({ step: "task_create", ok: true, httpStatus: res.status });
    return String(id);
  }

  /** Polls until success/error or budget exhausted. HTTP 200 alone never counts as success. */
  async pollTask(taskId: string): Promise<ParsedResult> {
    const deadline = Date.now() + this.budget;
    for (;;) {
      const res = await this.f(`${this.base}${this.taskEp}/${encodeURIComponent(taskId)}`, { headers: this.auth() });
      if (!res.ok) {
        this.audit.record({ step: "task_poll", ok: false, httpStatus: res.status });
        throw new YoucamError("task_poll", "http_error", res.status);
      }
      const body: any = await res.json().catch(() => ({}));
      const data = body?.data ?? body;
      const kind = classifyStatus(data?.task_status ?? data?.status);
      if (kind === "error") {
        const code = data?.error ?? data?.error_code;
        this.audit.record({ step: "task_poll", ok: false, httpStatus: res.status, code });
        return { ok: false, reason: "task_error", code: safeCode(code) };
      }
      if (kind === "success") {
        this.audit.record({ step: "task_poll", ok: true, httpStatus: res.status });
        const parsed = parseResult(data);
        this.audit.record({ step: "result_parse", ok: parsed.ok, code: parsed.ok ? undefined : parsed.reason });
        return parsed;
      }
      const interval = Number(data?.polling_interval) * 1000 || 2000;
      if (Date.now() + interval >= deadline) {
        this.audit.record({ step: "task_poll", ok: false, code: "poll_timeout" });
        throw new YoucamError("task_poll", "poll_timeout");
      }
      await this.sleep(interval);
    }
  }
}

async function providerCode(res: Response): Promise<string | undefined> {
  try {
    const b: any = await res.json();
    return b?.error ?? b?.error_code ?? b?.code;
  } catch {
    return undefined;
  }
}

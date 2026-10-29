import { NextResponse } from "next/server";
import { AuditLog } from "@/lib/organos-audit.ts";
import { preflight } from "@/lib/organos-image.ts";
import {
  YoucamClient, YoucamError, configFromEnv, validateActions, DEFAULT_ACTIONS,
} from "@/lib/organos-youcam.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET ?check=credit : free key/balance check (no analysis credits spent). */
export async function GET(req: Request) {
  const audit = new AuditLog();
  if (new URL(req.url).searchParams.get("check") !== "credit") {
    return NextResponse.json({ ok: false, error: "use ?check=credit" }, { status: 400 });
  }
  try {
    const client = new YoucamClient(configFromEnv(), audit);
    const data = await client.getCredit();
    return NextResponse.json({ ok: true, credit: data, audit: audit.toJSON() });
  } catch (e) {
    return failure(e, audit);
  }
}

/**
 * POST multipart: image (file), actions (JSON string, optional), confirmPaid ("yes").
 * Default is a DRY RUN: preflight only, no paid call. A paid call needs BOTH
 * confirmPaid=yes AND the server env ORGANOS_ALLOW_PAID=1.
 */
export async function POST(req: Request) {
  const audit = new AuditLog();
  try {
    const form = await req.formData();
    const file = form.get("image");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "image_required" }, { status: 400 });

    let actions = DEFAULT_ACTIONS;
    const rawActions = form.get("actions");
    if (typeof rawActions === "string" && rawActions) actions = JSON.parse(rawActions);
    validateActions(actions);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const pf = preflight(bytes);
    const blocking = pf.issues.filter((i) => i.blocking);
    audit.record({ step: "preflight", ok: blocking.length === 0, code: blocking[0]?.code });

    const paid = form.get("confirmPaid") === "yes" && process.env.ORGANOS_ALLOW_PAID === "1";
    if (blocking.length > 0 || !paid) {
      return NextResponse.json({
        ok: blocking.length === 0,
        dryRun: true,
        paidCallMade: false,
        reason: blocking.length > 0 ? "preflight_blocked" : "paid_call_not_confirmed",
        image: pf.info && { width: pf.info.width, height: pf.info.height, bytes: pf.info.bytes, format: pf.info.format },
        issues: pf.issues,
        actions,
        audit: audit.toJSON(),
      }, { status: blocking.length > 0 ? 422 : 200 });
    }

    const client = new YoucamClient(configFromEnv(), audit);
    const contentType = pf.info!.format === "png" ? "image/png" : "image/jpeg";
    const target = await client.registerFile(bytes, `upload.${pf.info!.format === "png" ? "png" : "jpg"}`, contentType);
    await client.uploadFile(target, bytes, contentType);
    const taskId = await client.createTask(target.fileId, actions);
    const result = await client.pollTask(taskId);
    return NextResponse.json({ ok: result.ok, paidCallMade: true, result, audit: audit.toJSON() }, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return failure(e, audit);
  }
}

function failure(e: unknown, audit: AuditLog) {
  const step = e instanceof YoucamError ? e.step : "unknown";
  const code = e instanceof YoucamError ? e.code : "internal_error";
  // Only step + safe code leave the server. No stack traces, bodies, URLs or keys.
  return NextResponse.json({ ok: false, failedStep: step, code, audit: audit.toJSON() }, { status: 502 });
}

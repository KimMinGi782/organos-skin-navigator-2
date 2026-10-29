// OrganOS audit: records WHICH step failed and a safe error code.
// Never stores API keys, image bytes, presigned URLs, or raw response bodies.

export type Step =
  | "preflight"
  | "credit_check"
  | "file_register"
  | "file_upload"
  | "task_create"
  | "task_poll"
  | "result_parse";

export type AuditEntry = {
  step: Step;
  ok: boolean;
  httpStatus?: number;
  /** Provider error code such as "error_src_face_too_small", or an internal code. */
  code?: string;
  at: string;
};

const SAFE_CODE = /^[a-z0-9_.:-]{1,64}$/i;

/** Only short identifier-like codes pass. Anything else (URLs, keys, prose) is dropped. */
export function safeCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!SAFE_CODE.test(v)) return undefined;
  if (/^(bearer|sk-|key)/i.test(v)) return undefined;
  return v;
}

export class AuditLog {
  private entries: AuditEntry[] = [];

  record(e: Omit<AuditEntry, "at" | "code"> & { code?: unknown }): void {
    this.entries.push({
      step: e.step,
      ok: e.ok,
      httpStatus: e.httpStatus,
      code: safeCode(e.code),
      at: new Date().toISOString(),
    });
  }

  toJSON(): AuditEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  firstFailure(): AuditEntry | undefined {
    return this.entries.find((e) => !e.ok);
  }
}

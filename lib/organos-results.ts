// Result parsing. HTTP 200 and task_status "success" are different things;
// "success" with no extractable scores is still reported as a parse failure.
//
// The exact response schema is UNVERIFIED. Official notes only say scores live
// under `results` or `output[]` and each concern has `ui_score` (higher = better)
// and `raw_score`. This parser is tolerant and never invents values.

export type ConcernScore = { concern: string; uiScore: number };

export type ParsedResult =
  | { ok: true; scores: ConcernScore[]; skinType?: string }
  | { ok: false; reason: "task_error" | "not_success" | "no_scores"; code?: string };

const SUCCESS = new Set(["success", "succeed", "completed"]);
const FAILED = new Set(["error", "failed"]);

export function classifyStatus(status: unknown): "success" | "error" | "pending" {
  const s = typeof status === "string" ? status.toLowerCase() : "";
  if (SUCCESS.has(s)) return "success";
  if (FAILED.has(s)) return "error";
  return "pending";
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

export function parseResult(data: any): ParsedResult {
  const kind = classifyStatus(data?.task_status ?? data?.status);
  if (kind === "error") {
    return { ok: false, reason: "task_error", code: typeof data?.error === "string" ? data.error : data?.error_code };
  }
  if (kind !== "success") return { ok: false, reason: "not_success" };

  const root = data?.results ?? data?.output ?? data?.result;
  const scores: ConcernScore[] = [];
  let skinType: string | undefined;

  const take = (name: string, v: any) => {
    const ui = v?.ui_score;
    if (typeof ui === "number" && Number.isFinite(ui)) scores.push({ concern: name, uiScore: clamp(ui) });
    else if (/skin_type$/.test(name) && typeof v?.skin_type === "string") skinType = v.skin_type;
  };

  if (Array.isArray(root)) {
    for (const item of root) {
      const name = item?.type ?? item?.name ?? item?.concern;
      if (typeof name === "string") take(name, item);
    }
  } else if (root && typeof root === "object") {
    for (const [name, v] of Object.entries(root)) take(name, v);
  }

  if (scores.length === 0) return { ok: false, reason: "no_scores" };
  return { ok: true, scores, skinType };
}

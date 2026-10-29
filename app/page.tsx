"use client";

import { useState } from "react";
import { planPrep } from "@/lib/organos-geometry.ts";

async function prepare(file: File): Promise<{ blob: Blob; note: string }> {
  const bmp = await createImageBitmap(file);
  const p = planPrep(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = p.outW;
  c.height = p.outH;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, p.cropX, p.cropY, p.cropW, p.cropH, 0, 0, p.outW, p.outH);
  let q = 0.95;
  for (let i = 0; i < 5; i++) {
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= 5 * 1024 * 1024) {
      return { blob, note: `${bmp.width}x${bmp.height} -> ${p.outW}x${p.outH}${p.upscaled ? " (확대됨: 실제 해상도 아님, 더 큰 원본 권장)" : ""}` };
    }
    q -= 0.15;
  }
  throw new Error("image_too_large");
}

type Json = Record<string, any>;

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Json | null>(null);

  async function run() {
    if (!file) return;
    setBusy(true);
    setOut(null);
    const fd = new FormData();
    let prepNote = "";
    try {
      const prepared = await prepare(file);
      prepNote = prepared.note;
      fd.append("image", new File([prepared.blob], "upload.jpg", { type: "image/jpeg" }));
    } catch {
      setOut({ ok: false, code: "image_prepare_failed" });
      setBusy(false);
      return;
    }
    if (paid) fd.append("confirmPaid", "yes");
    try {
      const res = await fetch("/api/skin-analysis", { method: "POST", body: fd });
      setOut({ prep: prepNote, ...(await res.json()) });
    } catch {
      setOut({ ok: false, code: "network_error" });
    } finally {
      setBusy(false);
    }
  }

  async function credit() {
    setBusy(true);
    try {
      setOut(await (await fetch("/api/skin-analysis?check=credit")).json());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 16, fontFamily: "system-ui" }}>
      <h1>OrganOS Skin Navigator 2.0</h1>
      <p>기본은 <b>드라이런</b>(이미지 검사만, 유료 호출 없음)입니다.</p>

      <input type="file" accept="image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />

      <label style={{ display: "block", marginTop: 12 }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{" "}
        얼굴 사진이 외부 분석 서비스(YouCam)로 전송되는 것에 동의합니다.
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />{" "}
        유료 분석 1회를 실행합니다(크레딧 차감, 서버에서 허용된 경우에만).
      </label>

      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button disabled={!file || !consent || busy} onClick={run}>
          {paid ? "분석 실행(유료)" : "드라이런"}
        </button>
        <button disabled={busy} onClick={credit}>잔액 확인(무료)</button>
      </div>

      {out && <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{JSON.stringify(out, null, 2)}</pre>}
    </main>
  );
}

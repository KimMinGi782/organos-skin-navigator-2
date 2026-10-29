// Free, offline image preflight. Reads JPEG/PNG headers only (no dependencies).
//
// The thresholds come from the SKIN_AI reference project's comments, which
// say a live API rejected small images with `error_src_face_too_small` /
// `error_below_min_image_size` and that ~1440px+ short edge worked.
// This is a third-party observation, NOT an official YouCam specification.

export const MIN_SHORT_EDGE_HINT = 1440;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type ImageInfo = {
  format: "jpeg" | "png";
  width: number;
  height: number;
  bytes: number;
};

export type PreflightIssue = {
  code: "unsupported_format" | "too_large" | "short_edge_below_hint";
  message: string;
  blocking: boolean;
};

export function readImageInfo(buf: Uint8Array): ImageInfo | null {
  // PNG
  if (
    buf.length > 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { format: "png", width: dv.getUint32(16), height: dv.getUint32(20), bytes: buf.length };
  }
  // JPEG: walk segments to a SOFn marker
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (buf[i + 5] << 8) | buf[i + 6];
        const width = (buf[i + 7] << 8) | buf[i + 8];
        return { format: "jpeg", width, height, bytes: buf.length };
      }
      const len = (buf[i + 2] << 8) | buf[i + 3];
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

export function preflight(buf: Uint8Array): { info: ImageInfo | null; issues: PreflightIssue[] } {
  const info = readImageInfo(buf);
  const issues: PreflightIssue[] = [];
  if (!info) {
    issues.push({ code: "unsupported_format", message: "JPEG 또는 PNG만 지원합니다.", blocking: true });
    return { info, issues };
  }
  if (info.bytes > MAX_UPLOAD_BYTES) {
    issues.push({ code: "too_large", message: "파일이 5MB를 넘습니다.", blocking: true });
  }
  const shortEdge = Math.min(info.width, info.height);
  if (shortEdge < MIN_SHORT_EDGE_HINT) {
    issues.push({
      code: "short_edge_below_hint",
      message: `짧은 변 ${shortEdge}px < ${MIN_SHORT_EDGE_HINT}px. 외부 참고 구현에서 얼굴 크기/해상도 오류로 거절된 구간입니다(공식 규격 아님).`,
      blocking: true,
    });
  }
  return { info, issues };
}

// Pure geometry for client-side prep: center-crop to 3:4 portrait, then scale so the
// short edge reaches the hint. Numbers mirror the SKIN_AI reference project (third-party
// observation, not an official YouCam spec).

export const TARGET_ASPECT = 3 / 4;
export const MIN_SHORT_EDGE = 1440;
export const MAX_LONG_EDGE = 2560;

export type Plan = {
  cropX: number; cropY: number; cropW: number; cropH: number;
  outW: number; outH: number;
  /** True when the source had to be enlarged. Enlarging adds no real detail. */
  upscaled: boolean;
};

export function planPrep(srcW: number, srcH: number): Plan {
  let cropW = srcW;
  let cropH = srcH;
  if (srcW / srcH > TARGET_ASPECT) cropW = Math.round(srcH * TARGET_ASPECT);
  else cropH = Math.round(srcW / TARGET_ASPECT);
  const cropX = Math.round((srcW - cropW) / 2);
  const cropY = Math.round((srcH - cropH) / 2);

  let outW = cropW;
  let outH = cropH;
  let upscaled = false;
  if (outW < MIN_SHORT_EDGE) {
    const s = MIN_SHORT_EDGE / outW;
    outW = MIN_SHORT_EDGE;
    outH = Math.round(outH * s);
    upscaled = true;
  }
  if (outH > MAX_LONG_EDGE) {
    const s = MAX_LONG_EDGE / outH;
    outH = MAX_LONG_EDGE;
    outW = Math.round(outW * s);
  }
  return { cropX, cropY, cropW, cropH, outW, outH, upscaled };
}

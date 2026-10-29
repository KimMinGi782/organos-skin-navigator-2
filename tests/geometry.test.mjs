import test from "node:test";
import assert from "node:assert/strict";
import { planPrep } from "../lib/organos-geometry.ts";

test("1031x1536 is cropped to 3:4 and enlarged to short edge 1440", () => {
  const p = planPrep(1031, 1536);
  assert.equal(p.cropW, 1031);
  assert.equal(p.cropH, 1375);
  assert.equal(p.outW, 1440);
  assert.ok(p.upscaled);
  assert.ok(Math.abs(p.outW / p.outH - 0.75) < 0.01);
});
test("large landscape photo is center-cropped, not enlarged", () => {
  const p = planPrep(4000, 3000);
  assert.equal(p.cropH, 3000);
  assert.equal(p.cropW, 2250);
  assert.equal(p.cropX, 875);
  assert.ok(!p.upscaled);
  assert.ok(p.outH <= 2560);
});

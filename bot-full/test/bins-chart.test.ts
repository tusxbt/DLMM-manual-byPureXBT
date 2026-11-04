import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketize, renderBinsChart } from "../src/render/bins-chart.js";
import { binAmountsFrom } from "../src/engine/dlmm-read.js";

const base = { pair: "A/SOL", minBin: 0, maxBin: 699, activeId: 350, pxUsd: 1, pyUsd: 100, priceOf: (i: number) => 1 + i / 1000 };
test("bucketize downsamples wide positions and counts filled bins", () => {
  const bins = Array.from({ length: 700 }, (_, i) => ({ id: i, x: i > 350 ? 1 : 0, y: i < 300 ? 0.01 : 0 }));
  const r = bucketize({ ...base, bins });
  assert.equal(r.buckets.length, 70);
  assert.equal(r.total, 700);
  assert.equal(r.filled, 300 + 349);
  assert.equal(r.unit, "usd");
  const sum = r.buckets.reduce((s, b) => s + b.xv + b.yv, 0);
  assert.ok(Math.abs(sum - (349 + 300)) < 1e-6);
});
test("renderBinsChart returns PNG; binAmountsFrom scales decimals", () => {
  const png = renderBinsChart({ ...base, maxBin: 10, bins: [{ id: 3, x: 1, y: 0 }] });
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.deepEqual(binAmountsFrom([{ binId: 2, positionXAmount: "1000000", positionYAmount: "0" }], 6, 9), [{ id: 2, x: 1, y: 0 }]);
});

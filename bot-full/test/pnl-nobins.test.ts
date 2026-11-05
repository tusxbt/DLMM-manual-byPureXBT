import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
test("PnL card: no bins histogram, chart full width, still renders", () => {
  const src = fs.readFileSync(new URL("../src/render/pnl-card.ts", import.meta.url), "utf8");
  assert.ok(!/binLiq|idealBins|bucketBins/.test(src));
  assert.match(src, /cw = W - 140/);
  assert.match(src, /max bin/);
  assert.ok(!/bin_liq|binLiqFrom/.test(fs.readFileSync(new URL("../src/engine/dlmm-read.ts", import.meta.url), "utf8")));
});

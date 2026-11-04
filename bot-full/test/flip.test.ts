import { test } from "node:test";
import assert from "node:assert/strict";
import { planFlipRange } from "../src/engine/flip.js";
import { renderFlipPreview, positionKeyboard, reshapeMenu } from "../src/telegram/positions-view.js";
import { expiredAction } from "../src/engine/confirm.js";

const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
test("planFlipRange: token X goes above active within position, capped 69", () => {
  assert.deepEqual(planFlipRange({ activeBinId: 100, lower: 50, upper: 120, tokenIsX: true }), { ok: true, minBinId: 101, maxBinId: 120, bins: 20, capped: false });
  const w = planFlipRange({ activeBinId: 0, lower: -10, upper: 500, tokenIsX: true });
  assert.ok(w.ok && w.minBinId === 1 && w.maxBinId === 69 && w.capped);
  assert.equal(planFlipRange({ activeBinId: 130, lower: 50, upper: 120, tokenIsX: true }).ok, false);
  assert.deepEqual(planFlipRange({ activeBinId: 100, lower: 50, upper: 120, tokenIsX: false }), { ok: true, minBinId: 50, maxBinId: 99, bins: 50, capped: false });
});
test("flip preview: empty → message; blocked when SOL short in LIVE", () => {
  const base = { pool: A, position: A, lower: 0, upper: 68, activeBinId: 30, tokenUi: 0, tokenUsd: 0, solFromMixedUi: 0, base: null, empty: true, target: planFlipRange({ activeBinId: 30, lower: 0, upper: 68, tokenIsX: true }) };
  const e = renderFlipPreview(base);
  assert.match(e.text, /Tidak ada token untuk di-flip/);
  assert.ok(e.blocked);
  const full = { ...base, empty: false, tokenUi: 1000, tokenUsd: 5, base: { tokenBins: [{}, {}], tokenRanges: [{ from: 31, to: 32 }] } as never };
  const ok = renderFlipPreview(full, { ok: true, needSol: 0.014, haveSol: 1 }, true);
  assert.ok(!ok.blocked);
  assert.match(ok.text, /BidAsk · bins \[31, 68\]/);
  assert.ok(renderFlipPreview(full, { ok: false, needSol: 0.014, haveSol: 0 }, true).blocked);
});
test("Detail keyboard has Reshape; reshape menu has Flip + Kembali; flip confirm re-previews on expiry", () => {
  const kb = JSON.stringify(positionKeyboard(A));
  assert.ok(kb.includes(`pv:rs:${A}`) && kb.includes("🔁 Reshape"));
  const m = JSON.stringify(reshapeMenu({ position: A }).kb);
  assert.ok(m.includes(`pv:flip:${A}`) && m.includes(`pv:open:${A}`) && m.includes(`pv:rsnew:${A}`));
  assert.deepEqual(expiredAction({ purpose: "flip", payload: { position: A } }), { kind: "flip", position: A });
});

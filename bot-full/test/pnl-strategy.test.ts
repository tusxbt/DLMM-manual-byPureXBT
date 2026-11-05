import { test } from "node:test";
import assert from "node:assert/strict";
import { strategyTag, renderPnlCard } from "../src/render/pnl-card.js";

test("strategy tag: Spot/Curve/BidAsk, Mix kept, unknown → MANUAL", () => {
  assert.equal(strategyTag("Spot"), "SPOT");
  assert.equal(strategyTag("curve"), "CURVE");
  assert.equal(strategyTag("Bid-Ask"), "BIDASK");
  assert.equal(strategyTag("bid_ask"), "BIDASK");
  assert.equal(strategyTag("Mix 70/30"), "MIX 70/30");
  assert.equal(strategyTag(null), "MANUAL");
  assert.equal(strategyTag(""), "MANUAL");
});
test("card renders with min/max bin lines and strategy (incl. price outside candles)", () => {
  const candles = Array.from({ length: 10 }, (_, i) => ({ t: i, o: 1 + i * 0.01, c: 1 + i * 0.01, h: 1.1, l: 0.9 }));
  for (const strategy of ["Spot", null]) {
    const png = renderPnlCard({ pair: "A/SOL", position: "P", closed: true, depositUsd: 1, exitUsd: 1, feesUsd: 0, pnlUsd: 0, pnlPct: 0, duration: "1m", minPrice: 0.5, maxPrice: 2, candles, strategy } as never);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
  }
});

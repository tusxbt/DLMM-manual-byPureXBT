import { test } from "node:test";
import assert from "node:assert/strict";
import { idealBins, bucketBins, renderPnlCard } from "../src/render/pnl-card.js";
import { binLiqFrom } from "../src/engine/dlmm-read.js";
import { snapshotOf, cardDataFromSnapshot } from "../src/telegram/pnl-send.js";

test("binLiqFrom: raw per-bin amounts per side, sorted by price", () => {
  const r = binLiqFrom([{ binId: 1, positionXAmount: "2000000", positionYAmount: "0" }, { binId: -1, positionXAmount: "0", positionYAmount: "500000000" }], 100, 6, 9)!;
  assert.equal(r.length, 2);
  assert.ok(r[0].p < r[1].p);
  assert.equal(r[0].y, 0.5);
  assert.equal(r[1].x, 2);
});
test("ideal shapes: BidAsk grows away from active, Spot flat; SOL below / token above", () => {
  const b = idealBins("Bid-Ask", 1, 2, 1.5, 21);
  assert.ok(b[0].y > b[9].y && b[0].x === 0 && b[20].x > b[12].x && b[20].y === 0);
  const s = idealBins("Spot", 1, 2, 1.5, 21);
  assert.ok(s.every((x) => x.x + x.y === 1));
});
test("bucketBins caps bars and keeps the mean", () => {
  const bins = Array.from({ length: 700 }, (_, i) => ({ p: 1 + i / 1000, x: 1, y: 0 }));
  const out = bucketBins(bins, 60);
  assert.ok(out.length <= 60);
  assert.ok(out.every((b) => b.x === 1));
});
test("snapshot carries real bin shape to the card (changes after flip); renders with and without", () => {
  const liq = [{ p: 1, x: 0, y: 1 }, { p: 1.1, x: 2, y: 0 }];
  const snap = snapshotOf({ pool: "P", position: "Q", bin_liq: liq, min_price: 1, max_price: 1.1 });
  assert.deepEqual(cardDataFromSnapshot(snap, true).binLiq, liq);
  const candles = Array.from({ length: 10 }, (_, i) => ({ t: i, o: 1 + i * 0.01, c: 1 + i * 0.01, h: 1.1, l: 0.9 }));
  for (const binLiq of [liq, null])
    assert.equal(renderPnlCard({ pair: "A/SOL", position: "P", closed: true, depositUsd: 1, exitUsd: 1, feesUsd: 0, pnlUsd: 0, pnlPct: 0, duration: "1m", minPrice: 1, maxPrice: 1.1, candles, strategy: "Spot", binLiq } as never).subarray(1, 4).toString(), "PNG");
});
test("idealised fallback follows deposit side: SOL-only below price, token-only above; no double side", async () => {
  const { sideOf } = await import("../src/telegram/pnl-send.js");
  assert.equal(sideOf(0, 1), "sol");
  assert.equal(sideOf(5, 0), "token");
  assert.equal(sideOf(5, 1), "both");
  const sol = idealBins("Bid-Ask", 1, 2, 1.5, 21, "sol");
  assert.ok(sol.every((b) => b.x === 0 && b.y > 0));
  assert.ok(sol[0].y > sol[20].y, "SOL BidAsk grows away from price (down)");
  const tok = idealBins("Bid-Ask", 1, 2, 1.5, 21, "token");
  assert.ok(tok.every((b) => b.y === 0 && b.x > 0));
  assert.ok(tok[20].x > tok[0].x, "token BidAsk grows away from price (up)");
  const spot = idealBins("Spot", 1, 2, 1.5, 21, "sol");
  assert.ok(spot.every((b) => b.y === 1));
});
test("bucketBins uses mean so equal bins stay equal (no short last bar)", () => {
  const bins = Array.from({ length: 69 }, (_, i) => ({ p: 1 + i / 100, x: 0, y: 3 }));
  assert.ok(bucketBins(bins, 30).every((b) => b.y === 3));
});

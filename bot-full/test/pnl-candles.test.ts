import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderPnlCard, strategyTag } from "../src/render/pnl-card.js";
import type { Candle } from "../src/engine/ohlcv.js";

test("position card: line chart, no Status, no side tag, no candle drawer", () => {
  const src = fs.readFileSync(new URL("../src/render/pnl-card.ts", import.meta.url), "utf8");
  assert.ok(!/drawCandles|CANDLE_UP|CANDLE_DOWN/.test(src));
  assert.ok(!/\["Status"/.test(src));
  assert.ok(!/rotate\(-Math\.PI \/ 2\)/.test(src));
  assert.match(src, /monochrome line chart/);
  assert.match(src, /rgba\(232,232,232/);
  const candles: Candle[] = Array.from({ length: 24 }, (_, i) => {
    const o = 1 + Math.sin(i / 3) * 0.05;
    const c = o + (i % 3 === 0 ? -0.03 : 0.025);
    return { t: 1_700_000_000 + i * 300, o, c, h: Math.max(o, c) + 0.02, l: Math.min(o, c) - 0.02 };
  });
  const png = renderPnlCard({
    pair: "RAM/SOL", position: "P", closed: true, depositUsd: 100, exitUsd: 110, feesUsd: 2,
    pnlUsd: 10, pnlPct: 10, duration: "1j", minPrice: 0.9, maxPrice: 1.2, candles, strategy: "Mix 70/30",
    bins: 40, timeLabel: "05 Nov 2026 18:00 KST", exitLabel: "ZAPOUT",
  } as never);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(strategyTag("Mix 70/30"), "MIX 70/30");
});

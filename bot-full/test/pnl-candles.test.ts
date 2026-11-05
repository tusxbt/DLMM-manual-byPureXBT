import { test } from "node:test";
import assert from "node:assert/strict";
import { CANDLE_UP, CANDLE_DOWN, drawCandles, renderPnlCard, strategyTag } from "../src/render/pnl-card.js";
import { createCanvas } from "@napi-rs/canvas";
import fs from "node:fs";
import type { Candle } from "../src/engine/ohlcv.js";

test("candle palette is monochrome (no green/red)", () => {
  assert.equal(CANDLE_UP.toLowerCase(), "#e8e8e8");
  assert.equal(CANDLE_DOWN.toLowerCase(), "#3a3a3a");
  assert.ok(!/#22c55e|#34d399|#2a9d8f|#ef4444|#fb7185|#c97b84/i.test(CANDLE_UP + CANDLE_DOWN));
});

test("drawCandles uses real OHLC (distinct high/low from open/close)", () => {
  const c = createCanvas(200, 100).getContext("2d");
  const candles = [{ o: 1, h: 1.5, l: 0.5, c: 1.2 }, { o: 1.2, h: 1.3, l: 0.8, c: 0.9 }];
  // must not throw; Y/X cover the range
  const Y = (v: number) => 100 - ((v - 0.4) / 1.2) * 80;
  const X = (i: number) => 20 + i * 40;
  drawCandles(c, candles, 10, 180, 10, 80, Y, X);
  assert.equal(strategyTag("Mix 70/30"), "MIX 70/30");
});

test("position card: candlesticks + no Status row (no side tag)", () => {
  const candles: Candle[] = Array.from({ length: 24 }, (_, i) => {
    const o = 1 + Math.sin(i / 3) * 0.05;
    const c = o + (i % 3 === 0 ? -0.03 : 0.025);
    return { t: 1_700_000_000 + i * 300, o, c, h: Math.max(o, c) + 0.02, l: Math.min(o, c) - 0.02 };
  });
  const png = renderPnlCard({
    pair: "RAM/SOL", position: "P", closed: true, depositUsd: 100, exitUsd: 110, feesUsd: 2,
    pnlUsd: 10, pnlPct: 10, duration: "1j", minPrice: 0.9, maxPrice: 1.2, candles, strategy: "Mix 70/30",
    bins: 40, timeLabel: "05 Nov 2026 17:00 KST", exitLabel: "ZAPOUT",
  } as never);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.ok(png.length > 5000);
  // Status removed: the stats row no longer has a 6th "Status" cell — render still works with 5 cells
  const src = fs.readFileSync(new URL("../src/render/pnl-card.ts", import.meta.url), "utf8");
  assert.ok(!/\["Status"/.test(src));
  assert.ok(/drawCandles\(/.test(src));
  assert.ok(!/rotate\(-Math\.PI \/ 2\)/.test(src));
});

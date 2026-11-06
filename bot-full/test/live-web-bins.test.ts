import test from "node:test";
import assert from "node:assert/strict";
import { barsFromBinData, barsFromRange } from "../src/live-web/snapshot.js";
import { renderWebLiveMenu, positionKeyboard } from "../src/telegram/positions-view.js";
import { BOT_COMMANDS } from "../src/telegram/panels.js";

test("barsFromBinData normalizes real liquidity heights", () => {
  const bars = barsFromBinData(
    [
      { binId: 10, positionXAmount: "0", positionYAmount: "100" },
      { binId: 11, positionXAmount: "50", positionYAmount: "50" },
      { binId: 12, positionXAmount: "0", positionYAmount: "0" },
      { binId: 15, positionXAmount: "200", positionYAmount: "0" },
    ],
    10,
    15,
  );
  assert.equal(bars[0].binId, 10);
  assert.equal(bars[bars.length - 1].binId, 15);
  const byId = Object.fromEntries(bars.map((b) => [b.binId, b.height]));
  assert.equal(byId[15], 1);
  assert.equal(byId[10], 0.5);
  assert.equal(byId[12], 0);
  assert.ok(byId[11]! > 0 && byId[11]! <= 1);
});

test("barsFromBinData downsamples wide ranges", () => {
  const raw = Array.from({ length: 120 }, (_, i) => ({
    binId: 1000 + i,
    positionXAmount: String(i === 60 ? 9999 : 1),
    positionYAmount: "0",
  }));
  const bars = barsFromBinData(raw, 1000, 1119);
  assert.ok(bars.length <= 62);
  assert.ok(bars.some((b) => b.height === 1));
});

test("barsFromRange fallback still works", () => {
  assert.ok(barsFromRange(1, 10).length >= 2);
});

test("/web menu: empty + multi + keyboard callback ownership shape", () => {
  const empty = renderWebLiveMenu([]);
  assert.match(empty.text, /Belum ada posisi aktif/);
  assert.ok(empty.kb.inline_keyboard.flat().some((b) => (b as { callback_data?: string }).callback_data === "menu:add"));

  const A = "7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg";
  const B = "8c0g7zEwWuiw4CYEM7jtCXf9hdscckCWwYsK8zLW2udh";
  const cards = [
    {
      position: A,
      pool: "PoolA",
      pair: "BONK/SOL",
      strategy_text: "Spot",
      total_value_usd: 1,
      unclaimed_fees_usd: 0,
      pnl_usd: null,
      pnl_pct: null,
      in_range: true,
    },
    {
      position: B,
      pool: "PoolB",
      pair: "WIF/SOL",
      total_value_usd: 2,
      unclaimed_fees_usd: 0,
      pnl_usd: null,
      pnl_pct: null,
      in_range: false,
    },
  ] as never[];
  const m = renderWebLiveMenu(cards);
  assert.match(m.text, /2 posisi aktif/);
  const cbs = m.kb.inline_keyboard.flat().map((b) => (b as { callback_data?: string }).callback_data).filter(Boolean);
  assert.ok(cbs.includes(`pv:live:${A}`));
  assert.ok(cbs.includes(`pv:live:${B}`));
  assert.ok(cbs.includes("web:ref"));
  for (const c of cbs) assert.ok(Buffer.byteLength(c!) <= 64, c!);
});

test("position keyboard still has Live Bins; /web registered in BOT_COMMANDS", () => {
  const A = "7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg";
  const kb = positionKeyboard(A).inline_keyboard.flat().map((b) => (b as { callback_data: string }).callback_data);
  assert.ok(kb.includes(`pv:live:${A}`));
  assert.ok(BOT_COMMANDS.some((c) => c.command === "web"));
});

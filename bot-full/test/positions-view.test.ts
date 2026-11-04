import test from "node:test";
import assert from "node:assert/strict";
import { fmtTinyPrice, rangeBar, fmtAge, renderPositionCard, positionKeyboard } from "../src/telegram/positions-view.js";
import { binIdToUiPrice } from "../src/engine/dlmm-read.js";

test("fmtTinyPrice subscript zeros", () => {
  assert.equal(fmtTinyPrice(0.00000116), "0.0₅116");
  assert.equal(fmtTinyPrice(0.00000425), "0.0₅425");
  assert.equal(fmtTinyPrice(0.0000414), "0.0₄414");
  assert.equal(fmtTinyPrice(0.00123), "0.00123");
  assert.equal(fmtTinyPrice(1.5), "1.5");
  assert.equal(fmtTinyPrice(null), "?");
});

test("rangeBar marks current price", () => {
  const b = rangeBar(0.04, 1.04, 1);
  assert.match(b, /^−96% ━+●━* \+4%$/);
  assert.match(rangeBar(1, 2, 0.5), /◀/);
  assert.equal(rangeBar(0, 1, 1), "");
});

test("binIdToUiPrice", () => {
  assert.equal(binIdToUiPrice(0, 100, 6, 9), 0.001);
  assert.ok(Math.abs(binIdToUiPrice(1, 100, 9, 9) - 1.01) < 1e-12);
});

test("card: PnL n/a when cost unknown; real when known", () => {
  const base = {
    position: "Pos1111111111111111111111111111111111111111", pool: "PoolX", pair: "BONK/SOL",
    total_value_usd: 899.68, unclaimed_fees_usd: 7.53, pnl_usd: null, pnl_pct: null, in_range: true,
    min_price: 0.00000116, max_price: 0.00000425, active_price: 0.00000414,
  };
  const t = renderPositionCard(base as never, new Date("2026-11-04T04:25:48Z"));
  assert.match(t, /\*\*BONK\/SOL · DLMM\*\*/);
  assert.match(t, /PnL: n\/a/);
  assert.match(t, /Min: 0\.0₅116/);
  assert.match(t, /Max: 0\.0₅425/);
  assert.match(t, /Now: 0\.0₅414/);
  assert.match(t, /🟢 In range/);
  assert.match(t, /Update: 13:25:48 KST/);
  assert.match(t, /app\.meteora\.ag\/dlmm\/PoolX/);
  const t2 = renderPositionCard({ ...base, pnl_usd: 7.21, pnl_pct: 0.8, in_range: false } as never);
  assert.match(t2, /🟢 \+\$7\.21 \(\+0\.80%\)/);
  assert.match(t2, /🔴 Out of range/);
});

test("age + keyboard", () => {
  assert.equal(fmtAge(new Date(Date.now() - 53 * 60000).toISOString()), "53m");
  assert.equal(fmtAge(undefined), null);
  const kb = JSON.stringify(positionKeyboard(2).inline_keyboard);
  for (const cb of ["pv:exit:2", "pv:claim:2", "pv:zap:2", "pv:repo:2", "pv:flip:2", "pv:ref:2", "pv:list"]) assert.ok(kb.includes(cb), cb);
  assert.ok(positionKeyboard(0).inline_keyboard.every((r) => r.length <= 2));
});

import { renderPositionList, positionButtonLabel, PAGE_SIZE } from "../src/telegram/positions-view.js";

const mk = (i: number, o: Record<string, unknown> = {}) =>
  ({ position: `P${i}`, pool: "X", pair: "BCAT/SOL", total_value_usd: 100 + i, unclaimed_fees_usd: 1, pnl_usd: null, pnl_pct: null, in_range: true, ...o }) as never;

test("button label: range dot, value, PnL omitted when n/a", () => {
  assert.equal(positionButtonLabel(mk(23)), "🟢 BCAT/SOL $123");
  assert.equal(positionButtonLabel(mk(23, { in_range: false, pnl_pct: 4.04, pnl_usd: 5 })), "🔴 BCAT/SOL $123 +4.0%");
  assert.equal(positionButtonLabel(mk(0, { pnl_pct: -12.3, pnl_usd: -1 })), "🟢 BCAT/SOL $100 −12%");
});

test("list: one message, totals, paginated by 8", () => {
  const cards = Array.from({ length: 19 }, (_, i) => mk(i));
  const r0 = renderPositionList(cards, 0, true);
  assert.match(r0.text, /📊 Posisi DLMM \(19\)/);
  assert.match(r0.text, /Auto confirm close ON/);
  assert.match(r0.text, /Hal: 1\/3/);
  const cb = (r: ReturnType<typeof renderPositionList>) => r.kb.inline_keyboard.flat().map((b) => (b as { callback_data: string }).callback_data);
  assert.equal(cb(r0).filter((c) => c.startsWith("pv:open:")).length, PAGE_SIZE);
  assert.ok(cb(r0).includes("pv:pg:1") && !cb(r0).includes("pv:pg:-1") && cb(r0).includes("pv:lref"));
  const r2 = renderPositionList(cards, 99);
  assert.equal(r2.page, 2);
  assert.deepEqual(cb(r2).filter((c) => c.startsWith("pv:open:")), ["pv:open:16", "pv:open:17", "pv:open:18"]);
  assert.ok(cb(r2).includes("pv:pg:1") && !cb(r2).includes("pv:pg:3"));
  const one = renderPositionList([mk(1)], 0);
  assert.ok(!cb(one).some((c) => c.startsWith("pv:pg")));
  assert.match(renderPositionList([], 0).text, /Tidak ada posisi/);
});

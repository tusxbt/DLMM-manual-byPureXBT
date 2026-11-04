import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { toHtml, sigLine, escapeHtml } from "../src/telegram/html.js";
import { pickTimeframe, parseOhlcv, type Candle } from "../src/engine/ohlcv.js";
import { renderPnlCard, fmtPx } from "../src/render/pnl-card.js";
import { cardDataFromSnapshot } from "../src/telegram/pnl-send.js";

test("toHtml: escape, code (copy), bold, links", () => {
  assert.equal(toHtml("Ketik: <bins> & x"), "Ketik: &lt;bins&gt; &amp; x");
  assert.equal(toHtml("Pos `Ab<c>` **OK**"), "Pos <code>Ab&lt;c&gt;</code> <b>OK</b>");
  assert.equal(toHtml("[🔗 Solscan](https://solscan.io/tx/abc)"), '<a href="https://solscan.io/tx/abc">🔗 Solscan</a>');
  assert.equal(toHtml("`**not bold**`"), "<code>**not bold**</code>");
  assert.equal(escapeHtml("a<b"), "a&lt;b");
  assert.match(sigLine("5xSig"), /`5xSig`\n\[🔗 Solscan\]\(https:\/\/solscan\.io\/tx\/5xSig\)/);
  assert.equal(sigLine("DRY_RUN_SIG_1"), "`DRY_RUN_SIG_1`");
});

test("ohlcv timeframe + parse", () => {
  assert.equal(pickTimeframe(3600).step, 60);
  assert.equal(pickTimeframe(6 * 3600).step, 300);
  assert.equal(pickTimeframe(3 * 86400).step, 3600);
  const c = parseOhlcv({ data: { attributes: { ohlcv_list: [[200, 1, 2, 0.5, 1.5, 9], [100, 1, 1, 1, 1, 1], [300, "x", 1, 1, 1, 1]] } } });
  assert.deepEqual(c.map((x) => x.t), [100, 200]);
  assert.deepEqual(parseOhlcv({}), []);
});

test("card data: PnL n/a without deposit; real with deposit", () => {
  const base = { pool: "P", position: "Pos1111111111111", total_value_usd: 110, unclaimed_fees_usd: 5, opened_at: new Date(Date.now() - 3 * 3600e3).toISOString() };
  assert.equal(cardDataFromSnapshot(base, true).pnlUsd, null);
  const d = cardDataFromSnapshot({ ...base, cost_usd: 100 }, true);
  assert.equal(d.pnlUsd, 15);
  assert.equal(d.pnlPct, 15);
  assert.equal(d.exitUsd, 115);
  assert.match(d.duration!, /3j/);
  assert.equal(fmtPx(0.00000116), "0.0₅116");
});

test("render PnL card PNG (with and without chart)", () => {
  const candles: Candle[] = [];
  let p = 0.0000041;
  for (let i = 0; i < 60; i++) {
    const o = p;
    p = p * (1 + Math.sin(i / 5) * 0.03 + (Math.random() - 0.5) * 0.02);
    candles.push({ t: 1_700_000_000 + i * 300, o, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99, c: p });
  }
  const png = renderPnlCard({
    pair: "BCAT/SOL", position: "Pos1111111111111111111111111111111111", closed: true,
    depositUsd: 100, exitUsd: 115.3, feesUsd: 7.53, pnlUsd: 15.3, pnlPct: 15.3, duration: "53m",
    minPrice: 0.0000030, maxPrice: 0.0000046, entryPrice: 0.0000041, exitPrice: p, candles, timeLabel: "04 Nov 2026 23:25 KST",
  });
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  fs.writeFileSync("/tmp/dlmm-test-pnl.png", png);
  const bare = renderPnlCard({ pair: "X/SOL", position: "P", closed: false, depositUsd: null, exitUsd: null, feesUsd: null, pnlUsd: null, pnlPct: null, duration: null, minPrice: null, maxPrice: null, timeLabel: "-" });
  assert.ok(bare.length > 1000);
});

import { fillGaps, chartWindow } from "../src/engine/ohlcv.js";
import { niceTicks } from "../src/render/pnl-card.js";

test("fillGaps: continuous flat candles at prev close; head back-filled", () => {
  const c = fillGaps([{ t: 600, o: 1, h: 2, l: 1, c: 1.5 }, { t: 1200, o: 1.5, h: 1.6, l: 1.4, c: 1.4 }], 300, 0, 1500);
  assert.deepEqual(c.map((x) => x.t), [0, 300, 600, 900, 1200, 1500]);
  assert.deepEqual(c[3], { t: 900, o: 1.5, h: 1.5, l: 1.5, c: 1.5 });
  assert.equal(c[0].c, 1);
  assert.deepEqual(fillGaps([], 60, 0, 600), []);
});

test("chart window padding + 60–120 candles", () => {
  const w = chartWindow(10_000, 10_000 + 6 * 3600);
  assert.ok(w.from < 10_000 && w.to > 10_000 + 6 * 3600);
  for (const dur of [3600, 6 * 3600, 2 * 86400, 10 * 86400]) {
    const ww = chartWindow(0, dur);
    const n = (ww.to - ww.from) / pickTimeframe(ww.to - ww.from).step;
    assert.ok(n <= 120 && n >= 30, `${dur}: ${n}`);
  }
  assert.deepEqual(niceTicks(0.00129, 0.00137, 5), [0.0013, 0.00132, 0.00134, 0.00136]);
});

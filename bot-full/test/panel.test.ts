import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPanel,
  setStrategy,
  setRangePreset,
  panelMissing,
  parseBins,
  parsePriceRange,
  parsePositiveNumber,
  renderPanelText,
  panelKeyboard,
} from "../src/telegram/add-panel.js";
import { computeRange, splitBins, MAX_BINS_PER_POSITION } from "../src/telegram/add-panel.js";
import { BOT_COMMANDS, parseBinPresets, bottomKeyboard, replyKbAction } from "../src/telegram/panels.js";
import { amountFromPct, depositUsd } from "../src/telegram/add-panel.js";
import { coerceBinPresets } from "../src/store/settings.js";

const pool = (step: number) => ({ pool: "X", name: "A-SOL", bin_step: step });

test("bin presets give same bin count regardless of binStep; % follows binStep", () => {
  const a = computeRange(defaultPanel(pool(10)), 10, 1);
  const b = computeRange(defaultPanel(pool(100)), 100, 1);
  assert.equal(a.total, 40);
  assert.equal(b.total, 40);
  assert.equal(a.above, 0);
  assert.ok(b.downPct > a.downPct);
  assert.ok(Math.abs(b.downPct - (1 - Math.pow(1.01, -40)) * 100) < 1e-9);
  assert.ok(Math.abs((b.minPrice as number) - Math.pow(1.01, -40)) < 1e-12);
  assert.equal(b.maxPrice, 1);
});

test("two-sided splits; presets clamp to 1399", () => {
  assert.deepEqual(splitBins(41, "two_sided"), { below: 21, above: 20 });
  let p = setRangePreset(defaultPanel(pool(100)), "wide", { narrow: 20, medium: 40, wide: 5000 });
  assert.equal(p.range.kind === "preset" && p.range.bins, MAX_BINS_PER_POSITION);
  p = { ...p, side: "two_sided" };
  assert.equal(computeRange(p, 100, 1).total, 1399);
});

test("custom bins >1399 rejected; >69 allowed (wide); custom price clamped", () => {
  const p = { ...defaultPanel(pool(100)), amountSol: 1 };
  const big = computeRange({ ...p, range: { kind: "bins", below: 1300, above: 200 } }, 100, 1);
  assert.ok(big.error);
  assert.deepEqual(panelMissing({ ...p, range: { kind: "bins", below: 1300, above: 200 } }), ["Range"]);
  assert.ok(!computeRange({ ...p, range: { kind: "bins", below: 60, above: 20 } }, 100, 1).error);
  const pr = computeRange({ ...p, range: { kind: "price", min: 1e-9, max: 1.5 } }, 100, 1);
  assert.equal(pr.clamped, true);
  assert.ok(pr.total <= 1399 && !pr.error);
  const ok = computeRange({ ...p, range: { kind: "price", min: 0.8, max: 1 } }, 100, 1);
  assert.equal(ok.clamped, false);
  assert.equal(ok.below, Math.ceil(Math.log(1 / 0.8) / Math.log(1.01)));
  assert.ok(computeRange({ ...p, range: { kind: "price", min: 0.8, max: 1 } }, 100, undefined).error);
});

test("bin preset parsing / coercion", () => {
  assert.deepEqual(parseBinPresets("20 40 69"), { narrow: 20, medium: 40, wide: 69 });
  assert.deepEqual(parseBinPresets("20 40 300"), { narrow: 20, medium: 40, wide: 300 });
  assert.equal(parseBinPresets("20 40 1400"), null);
  assert.equal(parseBinPresets("20 40"), null);
  assert.deepEqual(coerceBinPresets({ narrow: 5, medium: 9999, wide: "x" }, { narrow: 20, medium: 40, wide: 69 }), { narrow: 5, medium: 1399, wide: 69 });
});

test("default panel: only pool+amount missing, sensible defaults", () => {
  const p = defaultPanel();
  assert.equal(p.strategyId, "bid_ask");
  assert.equal(p.side, "one_sided_sol");
  assert.equal(p.range.kind, "preset");
  assert.deepEqual(panelMissing(p), ["Pool", "Amount"]);
  const ready = { ...defaultPanel({ pool: "X", name: "A-SOL" }), amountSol: 0.5 };
  assert.deepEqual(panelMissing(ready), []);
});

test("edit one field keeps others", () => {
  let p = { ...defaultPanel({ pool: "X", name: "A-SOL" }), amountSol: 1 };
  p = setStrategy(p, "spot");
  assert.equal(p.strategyId, "spot");
  assert.equal(p.amountSol, 1);
  assert.equal(p.range.kind === "preset" && p.range.bins, 40); // medium default
  p = setRangePreset(p, "wide");
  assert.equal(p.range.kind === "preset" && p.range.presetId, "wide");
  assert.equal(p.pool?.name, "A-SOL");
  assert.throws(() => setRangePreset(p, "nope"));
});

test("parsers", () => {
  assert.deepEqual(parseBins("40 2"), { below: 40, above: 2 });
  assert.deepEqual(parseBins("10"), { below: 10, above: 0 });
  assert.equal(parseBins("0 0"), null);
  assert.equal(parseBins("a b"), null);
  assert.deepEqual(parsePriceRange("0,5 1.5"), { min: 0.5, max: 1.5 });
  assert.equal(parsePriceRange("2 1"), null);
  assert.equal(parsePositiveNumber("0,25"), 0.25);
  assert.equal(parsePositiveNumber("-1"), null);
});

test("render + keyboard (reference layout)", () => {
  const p = defaultPanel();
  const t = renderPanelText(p, { liqSlippagePct: 10, maxPositionUsd: 100, dryRun: true });
  assert.match(t, /kurang: Pool, Amount/);
  assert.match(t, /DRY_RUN/);
  const kb = panelKeyboard(p, { amountPresets: [0.5, 1, 2] }).inline_keyboard;
  const flat = JSON.stringify(kb);
  for (const cb of ["ap:set:strat:spot", "ap:set:mode:one_sided_token", "ap:set:rng:wide", "ap:set:pct:100", "ap:edit:range", "ap:edit:amount", "ap:deploy", "ap:pools", "ap:home"])
    assert.ok(flat.includes(cb), cb);
  // short labels so Telegram doesn't truncate
  for (const row of kb) for (const b of row) assert.ok(b.text.length <= 12, b.text);
  assert.ok(flat.includes('40b') && flat.includes('"69b'));
  // token side hides SOL presets
  assert.ok(!JSON.stringify(panelKeyboard({ ...p, side: "one_sided_token" }, { amountPresets: [0.5] }).inline_keyboard).includes("ap:set:amt:"));
});

test("panel text: token hint, range %, USD", () => {
  const p = { ...defaultPanel({ pool: "PoolAddr111111", name: "BONK-SOL", bin_step: 100, fee_pct: 1, tvl: 5000, token_x: { symbol: "BONK", mint: "M" } }), activePrice: 1, solUsd: 150, solBalance: 2, tokenBalance: 0, amountSol: 0.5 };
  const t = renderPanelText(p, { liqSlippagePct: 10, maxPositionUsd: 100, dryRun: false });
  assert.match(t, /🎯 Setup BONK · BONK-SOL/);
  assert.match(t, /Range: 40 bins \(−32\.8% → \+0% ?\)|Range: 40 bins \(−32\.8/);
  assert.match(t, /Token side \/ Double tidak tersedia/);
  assert.match(t, /≈ \$75/);
});

test("amountFromPct keeps SOL reserve; depositUsd needs token price", () => {
  const p = { ...defaultPanel(), solBalance: 1.05, tokenBalance: 1000 };
  assert.equal(amountFromPct(p, 100).sol, 1);
  assert.equal(amountFromPct(p, 50).sol, 0.5);
  assert.equal(amountFromPct({ ...p, side: "one_sided_token" }, 25).token, 250);
  assert.equal(depositUsd({ ...p, side: "one_sided_token", amountToken: 10 }), null);
  assert.equal(depositUsd({ ...p, side: "one_sided_token", amountToken: 10, tokenUsd: 2 }), 20);
  assert.equal(depositUsd({ ...p, side: "two_sided", amountSol: 1, amountToken: 10, tokenUsd: 2, solUsd: 100 }), 120);
  assert.deepEqual(splitBins(30, "one_sided_token"), { below: 0, above: 30 });
});

test("bottom reply keyboard maps labels", () => {
  assert.equal(replyKbAction("👛 Wallet"), "wallet");
  assert.equal(replyKbAction("💱 Trade"), "trade");
  assert.equal(replyKbAction("random"), null);
  const kb = bottomKeyboard();
  assert.equal(kb.is_persistent, true);
  assert.equal(kb.resize_keyboard, true);
});

test("command menu valid for Telegram", () => {
  for (const c of BOT_COMMANDS) {
    assert.match(c.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(c.description.length >= 1 && c.description.length <= 256);
  }
  assert.ok(BOT_COMMANDS.some((c) => c.command === "add"));
});

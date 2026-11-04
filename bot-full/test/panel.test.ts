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
import { BOT_COMMANDS } from "../src/telegram/panels.js";

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
  assert.equal(p.range.kind === "preset" && p.range.downPct, 30); // spot medium
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

test("render + keyboard", () => {
  const p = defaultPanel();
  const t = renderPanelText(p, { liqSlippagePct: 10, maxPositionUsd: 100, dryRun: true });
  assert.match(t, /Lengkapi: Pool, Amount/);
  assert.match(t, /DRY_RUN/);
  const kb = JSON.stringify(panelKeyboard(p).inline_keyboard);
  for (const cb of ["ap:edit:pool", "ap:edit:amount", "ap:edit:strat", "ap:edit:range", "ap:edit:slip", "ap:deploy", "ap:cancel"])
    assert.ok(kb.includes(cb), cb);
  assert.ok(!kb.includes("ap:edit:token"));
  assert.ok(JSON.stringify(panelKeyboard({ ...p, side: "two_sided" }).inline_keyboard).includes("ap:edit:token"));
});

test("command menu valid for Telegram", () => {
  for (const c of BOT_COMMANDS) {
    assert.match(c.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(c.description.length >= 1 && c.description.length <= 256);
  }
  assert.ok(BOT_COMMANDS.some((c) => c.command === "add"));
});

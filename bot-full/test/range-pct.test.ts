import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.DATA_DIR ||= fs.mkdtempSync("/tmp/rp-");
const ap = await import("../src/telegram/add-panel.js");
const { coerceRangePct } = await import("../src/store/settings.js");
const pool = (bin_step: number) => ({ bin_step } as never);
const labels = (p: unknown) => (ap.panelKeyboard(p as never, {}).inline_keyboard as { text: string; callback_data: string }[][]).flat().filter((b) => b.callback_data.startsWith("ap:set:rng:")).map((b) => b.text);

test("default = 69 bins, % per bin step and side", () => {
  assert.equal(ap.defaultRangeLabel(100, "one_sided_sol"), "Default 69 bin ≈ -49.7%");
  assert.equal(ap.defaultRangeLabel(20, "one_sided_sol"), "Default 69 bin ≈ -12.9%");
  assert.match(ap.defaultRangeLabel(100, "one_sided_token"), /\+98\.7%/);
  const p = { ...ap.defaultPanel(pool(100)), side: "one_sided_sol" as const };
  assert.equal(p.range.kind, "def69");
  const d = ap.computeRange(p as never, 100, 1);
  assert.equal(d.total, 69); assert.equal(d.below, 69); assert.equal(d.above, 0);
  const t = ap.computeRange({ ...p, side: "one_sided_token" } as never, 100, 1);
  assert.equal(t.above, 69); assert.equal(t.below, 0);
  const two = ap.computeRange({ ...p, side: "two_sided" } as never, 100, 1);
  assert.equal(two.total, 69);
});

test("4 % presets: side-aware, % → bins ceil, clamp 1399", () => {
  let p = { ...ap.defaultPanel(pool(20)), side: "one_sided_sol" as const } as never;
  assert.deepEqual(labels(p).slice(1).map((x) => x.replace(/^✅ ?/, "")), ["-10%", "-25%", "-50%", "-80%"]);
  p = ap.setRangeChoice(p, "p2", [10, 25, 50, 80]);
  let d = ap.computeRange(p, 20, 1);
  assert.equal(d.below, Math.ceil(-Math.log(0.5) / Math.log(1.002))); assert.equal(d.above, 0);
  d = ap.computeRange({ ...(p as object), side: "one_sided_token" } as never, 20, 1);
  assert.equal(d.below, 0); assert.equal(d.above, Math.ceil(Math.log(1.5) / Math.log(1.002)));
  d = ap.computeRange({ ...(p as object), side: "two_sided" } as never, 20, 1);
  assert.ok(d.below > 0 && d.above > 0);
  const big = ap.computeRange(ap.setRangeChoice(p, "p3", [10, 25, 50, 80]), 1, 1);
  assert.equal(big.total, 1399); assert.equal(big.clamped, true); assert.ok(!big.error);
  assert.throws(() => ap.setRangeChoice(p, "p9", [1, 2, 3, 4]));
});

test("settings migrate: invalid/missing → defaults", () => {
  assert.deepEqual(coerceRangePct(undefined), [10, 25, 50, 80]);
  assert.deepEqual(coerceRangePct([1, 2]), [10, 25, 50, 80]);
  assert.deepEqual(coerceRangePct([5, 15, 30, 60]), [5, 15, 30, 60]);
});

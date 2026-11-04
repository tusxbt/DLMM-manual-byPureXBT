import { test } from "node:test";
import assert from "node:assert/strict";
import { binBar, renderPositionCard } from "../src/telegram/positions-view.js";
import { binMaskFrom } from "../src/engine/dlmm-read.js";

test("mask from positionBinData (X or Y > 0)", () => {
  const data = [
    { binId: 100, positionXAmount: "0", positionYAmount: "5" },
    { binId: 101, positionXAmount: "0", positionYAmount: "0" },
    { binId: 102, positionXAmount: "7", positionYAmount: "0" },
    { binId: 999, positionXAmount: "7", positionYAmount: "0" }, // outside → ignored
  ];
  assert.equal(binMaskFrom(data, 100, 103), "1010");
  assert.equal(binMaskFrom(undefined, 1, 2), undefined);
});

test("bar: 16 cells, active marker, filled count; wide downsample; out-of-range edge", () => {
  const mask = "1".repeat(42) + "0".repeat(27);
  const b = binBar(mask, 0, 50);
  assert.equal(b.filled, 42);
  assert.equal(b.total, 69);
  assert.equal([...b.bar].length, 16);
  assert.ok(b.bar.includes("▼"));
  assert.ok(b.bar.startsWith("█████████"));
  assert.ok(b.bar.endsWith("░"));
  const wide = binBar("1".repeat(700) + "0".repeat(700), 0, 1399);
  assert.equal([...wide.bar].length, 16);
  assert.equal(wide.filled, 700);
  assert.ok(wide.bar.endsWith("▼"));
  assert.ok(binBar("111", 10, 5).bar.startsWith("◀"));
  assert.ok(binBar("111", 10, 50).bar.endsWith("▶"));
  assert.equal(binBar("101", 0, null).bar, "█░█");
});

test("card shows bins bar (manual position too) in ≤2 lines", () => {
  const t = renderPositionCard({ position: "Pos1111111111111111111111111111111111111111", pool: "P", pair: "A/SOL", manual: true, total_value_usd: 10, unclaimed_fees_usd: 0, pnl_usd: null, pnl_pct: null, in_range: true, min_bin: 0, max_bin: 68, active_id: 30, bin_mask: "1".repeat(42) + "0".repeat(27) } as never);
  assert.match(t, /🧱 [█▒░▼]{16}/);
  assert.match(t, /Bins terisi: 42\/69/);
});

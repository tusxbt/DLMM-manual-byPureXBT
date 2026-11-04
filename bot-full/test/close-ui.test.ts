import { test } from "node:test";
import assert from "node:assert/strict";
import { compactResult } from "../src/telegram/close-ui.js";

test("compact close result is 2-3 lines with single tx link", () => {
  const t = compactResult({
    kind: "remove", pair: "AMD/SOL", success: true, signatures: ["a1", "b2", "c3"], ms: 3012, solReceived: 0.512,
    snapshot: { pool: "p", position: "q", total_value_usd: 52, unclaimed_fees_usd: 0.23, cost_usd: 51 },
  });
  const lines = t.split("\n");
  assert.ok(lines.length <= 3);
  assert.match(lines[0], /✅ Exit AMD\/SOL · \+\$1\.23 \(\+2\.4%\)/);
  assert.match(lines[1], /Realized setelah swap: \+0\.5120 SOL \(termasuk refund rent, minus fee tx & slippage\) · ⏱ 3\.0s/);
  assert.match(lines[2], /solscan\.io\/tx\/c3/);
  assert.equal((t.match(/solscan/g) || []).length, 1);
});

test("error is one line", () => {
  const t = compactResult({ kind: "zapout", pair: "X/SOL", success: false, signatures: [], ms: 1, error: "boom\nstack" });
  assert.equal(t, "❌ Zapout X/SOL gagal · boom");
});

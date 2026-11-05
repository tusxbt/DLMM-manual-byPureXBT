import { test } from "node:test";
import assert from "node:assert/strict";
import { compactResult } from "../src/telegram/close-ui.js";

test("compact close result is 2-3 lines with single tx link", () => {
  const t = compactResult({
    kind: "remove", pair: "AMD/SOL", success: true, signatures: ["a1", "b2", "c3"], ms: 3012, realized: { solNet: 0.512, tokenNet: {}, rentSol: 0.0574, feeSol: 0.0001, exitUsd: 50.2, pnlUsd: 1.2, pnlPct: 2.45 },
    snapshot: { pool: "p", position: "q", total_value_usd: 52, unclaimed_fees_usd: 0.23, cost_usd: 51 },
  });
  const lines = t.split("\n");
  assert.ok(lines.length <= 7);
  assert.match(lines[0], /✅ \*\*Exit AMD\/SOL\*\*/);
  // realized (from close txs, rent excluded) beats the snapshot estimate
  assert.match(t, /PnL: 🟢 \+\$1\.20 \(\+2\.45%\)/);
  assert.match(t, /Sumber: on-chain, tanpa rent/);
  assert.match(t, /Diterima: 0\.5120 SOL/);
  assert.match(t, /Waktu: 3\.0s/);
  assert.match(lines.at(-1)!, /solscan\.io\/tx\/c3/);
  for (const l of lines) assert.ok(l.replace(/\[(.*?)\]\(.*?\)/g, "$1").length <= 34, l);
  assert.equal((t.match(/solscan/g) || []).length, 1);
});

test("error is one line", () => {
  const t = compactResult({ kind: "zapout", pair: "X/SOL", success: false, signatures: [], ms: 1, error: "boom\nstack" });
  assert.equal(t, "❌ **Zapout X/SOL gagal**\nboom");
});

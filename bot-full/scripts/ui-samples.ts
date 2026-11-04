/** Render sample screens → ui-samples.md (no network). Usage: npx tsx scripts/ui-samples.ts [out.md] */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uis-"));
process.env.ALLOWED_TELEGRAM_USER_IDS = "111";
process.env.WALLET_ENCRYPTION_KEY = "a".repeat(64);
process.env.DRY_RUN = "false";
process.env.MAX_POSITION_USD = "100";
process.env.MAX_SWAP_USD = "100";
async function main() {
  const out = process.argv[2] || "ui-samples.md";
  const { renderAddPreview } = await import("../src/telegram/preview.js");
  const { renderPositionCard, renderPositionList } = await import("../src/telegram/positions-view.js");
  const { compactResult } = await import("../src/telegram/close-ui.js");
  const { walletText, adminText } = await import("../src/telegram/users-ui.js");
  const { settingsText } = await import("../src/telegram/panels.js");
  const { addUser } = await import("../src/users/store.js");
  addUser("222333444");
  const now = new Date("2026-11-05T00:30:00+09:00");
  const met = { position: "P", closed: false, pnlUsd: 0.91, pnlPct: 1.88, pnlSol: 0.009, depositUsd: 48.56, withdrawUsd: 0, feesUsd: 1.03, feeX: { amount: 2510, usd: 0.56 }, feeY: { amount: 0.0049, usd: 0.48 }, balanceUsd: 48.44, unclaimedFeesUsd: 0.62 };
  const card = {
    position: "7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg", pool: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", pair: "Donkey/SOL",
    total_value_usd: 49.06, unclaimed_fees_usd: 0.62, pnl_usd: 0.5, pnl_pct: 1.0, in_range: true, active_id: 10, bin_step: 100,
    min_price: 0.00000116, max_price: 0.00000425, active_price: 0.00000414, min_bin: 0, max_bin: 69, mint_x: "x", mint_y: "So11111111111111111111111111111111111111112",
    opened_at: "2026-11-04T21:10:00+09:00", cost_usd: 48.59, strategy_text: "Mix 70/30", meteora: met, mc_min: 1_160_000, mc_max: 4_250_000, mc_now: 4_140_000,
  };
  const preview = renderAddPreview({
    pool: "Donkey-SOL", side: "SOL side", strategy: "Mix 70/30", amount: "0.5 SOL", mix: { pct: 70, primaryText: "0.35 SOL", spotText: "0.15 SOL" },
    bins: 70, below: 70, above: 0, downPct: 50.2, upPct: 0, minPrice: 0.00000206, maxPrice: 0.00000414, solUsd: 97,
    mcMin: 2_060_000, mcMax: 4_140_000, mcNow: 4_140_000, costUsd: 48.5, capUsd: 100, slippagePct: 10,
    wide: { txCount: 3, positionRentSol: 0.0582, binArrayRentSol: 0, binArraysCount: 0 }, position: card.position, dryRun: false, ttlSec: 60,
  });
  const list = renderPositionList([card as never, { ...card, pair: "BONK/SOL", in_range: false, meteora: null } as never], 0).text;
  const close = compactResult({ kind: "zapout", pair: "Donkey/SOL", success: true, signatures: ["a", "5xTxSig"], ms: 3012, solReceived: 0.5509, snapshot: { pool: "p", position: "q", total_value_usd: null, unclaimed_fees_usd: null, meteora: { ...met, closed: true } } });
  const closeErr = compactResult({ kind: "remove", pair: "AMD/SOL", success: false, signatures: [], ms: 1, error: "block height exceeded" });
  const wallet = walletText({ wallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", sol: 1.2345, solUsd: 119.75, usdc: 12.5, totalUsd: 132.25, owner: true, dryRun: false, capPos: 100, capSwap: 100 });
  const blocks: [string, string][] = [["/add Preview", preview], ["Position card", renderPositionCard(card as never, now)], ["Positions list (+ 1 button per posisi)", list], ["Close / Zapout result (+ ℹ️ Detail button)", close], ["Close error", closeErr], ["Wallet", wallet], ["Admin", adminText()], ["Settings", settingsText()]];
  const md = ["# DLMM bot — UI samples", "", "`**x**` = bold, backtick = tap-to-copy. Max line excludes addresses (own line).", ""];
  for (const [t, b] of blocks) {
    const lens = b.split("\n").filter((l) => !/^`[1-9A-HJ-NP-Za-km-z]{32,44}`$/.test(l.trim())).map((l) => l.replace(/\[(.*?)\]\(.*?\)/g, "$1").replace(/\*\*|`/g, "").length);
    md.push(`## ${t}`, "", `_max line: ${Math.max(...lens)} chars_`, "", "```", b, "```", "");
  }
  fs.writeFileSync(out, md.join("\n"));
}
main();

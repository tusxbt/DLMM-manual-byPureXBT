import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPoolForTest } from "../src/engine/dlmm-read.js";
import { poolStatLines, poolButtonLabel, poolBlock } from "../src/telegram/pool-format.js";

// shape checked live on dlmm.datapi.meteora.ag/pools (Nov 2026)
const live = {
  address: "BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh", name: "SOL-USDC",
  token_x: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
  pool_config: { bin_step: 20, base_fee_pct: 0.2 },
  tvl: 2335052.07,
  volume: { "24h": 1692149.01 },
  fees: { "24h": 3095.49 },
  fee_tvl_ratio: { "24h": 0.1325662870208617 },
  cumulative_metrics: { volume: 5747915754.1, fees: 11326943.36 },
};

test("datapi pool → fees 24h / total / fee-TVL", () => {
  const p = mapPoolForTest(live);
  assert.equal(p.fees_24h, 3095.49);
  assert.equal(p.fees_total, 11326943.36);
  assert.equal(p.volume_24h, 1692149.01);
  assert.ok(Math.abs((p.fee_tvl_24h_pct ?? 0) - 0.1326) < 1e-3);
  assert.deepEqual(poolStatLines(p), ["bin 20 · fee 0.2%", "TVL $2.34M · F24 $3.1K (0.13%) · Tot $11.3M"]);
  assert.equal(poolBlock(p, 0), "1. **SOL-USDC** · bin 20 · fee 0.2%\n   TVL $2.34M · F24 $3.1K (0.13%) · Tot $11.3M");
  assert.ok(poolButtonLabel(p).length <= 40);
});

test("missing stats → n/a", () => {
  const p = mapPoolForTest({ address: "x", name: "A-SOL" });
  assert.deepEqual(poolStatLines(p), ["bin n/a · fee n/a", "TVL n/a · F24 n/a · Tot n/a"]);
});

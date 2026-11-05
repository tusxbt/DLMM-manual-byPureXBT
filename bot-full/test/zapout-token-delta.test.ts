import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenDeltaFromFlows, type TxFlow } from "../src/engine/realized.js";
import { clampSwapAmount } from "../src/engine/reshape.js";

const W = "Wallet111";
const TOK = "E1PpVMPtWPhPUKL7DbF6f2eAmuwo3CHBkKusKk54pump"; // ZELDA (Token-2022)

/** Two close txs like the live ZELDA zapout: first deposits 180085.1418, second +636.488801. */
function zeldaFlows(): TxFlow[] {
  const a = "180085141800";
  const b = "180721630601";
  return [
    {
      keys: [W, "ata", "pos"],
      pre: [1e9, 0, 0], post: [1e9, 0, 0], fee: 5000, feePayer: W,
      preTok: [{ i: 1, mint: TOK, owner: W, amount: "0", decimals: 6 }],
      postTok: [{ i: 1, mint: TOK, owner: W, amount: a, decimals: 6 }],
    },
    {
      keys: [W, "ata", "pos"],
      pre: [1e9, 0, 0], post: [1e9, 0, 0], fee: 5000, feePayer: W,
      preTok: [{ i: 1, mint: TOK, owner: W, amount: a, decimals: 6 }],
      postTok: [{ i: 1, mint: TOK, owner: W, amount: b, decimals: 6 }],
    },
  ];
}

test("tokenDeltaFromFlows: sums ZELDA received across 2 close txs (Token-2022)", () => {
  const d = tokenDeltaFromFlows(zeldaFlows(), W, TOK);
  assert.equal(d, 180721630601n);
  assert.equal(Number(d) / 1e6, 180721.630601);
  assert.equal(tokenDeltaFromFlows(zeldaFlows(), W, "OtherMint"), 0n);
  assert.equal(tokenDeltaFromFlows(zeldaFlows(), "NotWallet", TOK), 0n);
});

test("clampSwapAmount: never oversell; stale wallet → 0", () => {
  assert.equal(clampSwapAmount(180721630601n, 180721630601n), 180721630601n);
  assert.equal(clampSwapAmount(180721630601n, 100n), 100n); // partial already sold
  assert.equal(clampSwapAmount(180721630601n, 0n), 0n); // RPC still shows 0 → do not invent a swap
  assert.equal(clampSwapAmount(0n, 999n), 0n);
  assert.equal(clampSwapAmount(-1n, 999n), 0n);
});

test("stale balance-only path would miss the swap; tx delta catches it", () => {
  // balBefore=0, balAfter still 0 (indexer lag) → old logic skipped swap
  const balBefore = 0n, balAfter = 0n;
  assert.ok(!(balAfter - balBefore > 0n));
  const fromTx = tokenDeltaFromFlows(zeldaFlows(), W, TOK);
  assert.ok(fromTx > 0n);
  // once the ATA is visible:
  assert.equal(clampSwapAmount(fromTx, fromTx), fromTx);
});

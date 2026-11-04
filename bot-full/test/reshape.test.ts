import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBin,
  classifyPositionBins,
  contiguousRanges,
  clampReshapeWidth,
  rangeAboveActive,
  atomicToUi,
  toBigIntAmount,
} from "../src/engine/reshape-math.js";

test("toBigIntAmount parses SDK strings", () => {
  assert.equal(toBigIntAmount("12345"), 12345n);
  assert.equal(toBigIntAmount("0"), 0n);
  assert.equal(toBigIntAmount(null), 0n);
  assert.equal(toBigIntAmount("12.9"), 12n);
});

test("classifyBin sol-on-Y: token/sol/both/empty", () => {
  assert.equal(classifyBin({ binId: 1, positionXAmount: "100", positionYAmount: "0" }, "y").kind, "token_only");
  assert.equal(classifyBin({ binId: 2, positionXAmount: "0", positionYAmount: "50" }, "y").kind, "sol_only");
  assert.equal(classifyBin({ binId: 3, positionXAmount: "10", positionYAmount: "20" }, "y").kind, "both");
  assert.equal(classifyBin({ binId: 4, positionXAmount: "0", positionYAmount: "0" }, "y").kind, "empty");
});

test("classifyBin sol-on-X flips token side", () => {
  const b = classifyBin({ binId: 1, positionXAmount: "0", positionYAmount: "99" }, "x");
  assert.equal(b.kind, "token_only");
  assert.equal(b.tokenAtomic, 99n);
});

test("contiguousRanges merges interleaved gaps", () => {
  assert.deepEqual(contiguousRanges([]), []);
  assert.deepEqual(contiguousRanges([5]), [{ from: 5, to: 5 }]);
  assert.deepEqual(contiguousRanges([1, 2, 3, 7, 8, 10]), [
    { from: 1, to: 3 },
    { from: 7, to: 8 },
    { from: 10, to: 10 },
  ]);
});

test("classifyPositionBins withdraws token+both, leaves sol_only", () => {
  const bins = [
    { binId: 10, positionXAmount: "0", positionYAmount: "1000" }, // sol
    { binId: 11, positionXAmount: "500", positionYAmount: "0" }, // token
    { binId: 12, positionXAmount: "200", positionYAmount: "50" }, // both
    { binId: 14, positionXAmount: "100", positionYAmount: "0" }, // token gap
  ];
  const r = classifyPositionBins(bins, "y");
  assert.equal(r.tokenBins.length, 3);
  assert.equal(r.bothCount, 1);
  assert.deepEqual(r.tokenRanges, [
    { from: 11, to: 12 },
    { from: 14, to: 14 },
  ]);
  assert.equal(r.totalTokenAtomic, 800n);
  assert.equal(r.totalSolInTokenBinsAtomic, 50n); // SOL in "both" bin also withdrawn
});

test("clampReshapeWidth and rangeAboveActive", () => {
  assert.equal(clampReshapeWidth(0, 7), 7);
  assert.equal(clampReshapeWidth(100, 7), 69);
  assert.equal(clampReshapeWidth(3, 7), 3);
  const r = rangeAboveActive(1000, 5);
  assert.deepEqual(r, { minBinId: 1001, maxBinId: 1005, binsAbove: 5, binsBelow: 0 });
});

test("atomicToUi", () => {
  assert.equal(atomicToUi(1_500_000n, 6), 1.5);
  assert.equal(atomicToUi(2_000_000_000n, 9), 2);
});

test("no token bins detection for reshape preview gate", () => {
  const bins = [
    { binId: 1, positionXAmount: "0", positionYAmount: "10" },
    { binId: 2, positionXAmount: "0", positionYAmount: "20" },
  ];
  const r = classifyPositionBins(bins, "y");
  assert.equal(r.tokenBins.length, 0);
  assert.deepEqual(r.tokenRanges, []);
});

test("confirm purpose accepts reshape + DRY_RUN executeReshape with analysis", async () => {
  const { Keypair } = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;
  process.env.DLMM_SKIP_ENV_CHMOD = "1";
  process.env.ALLOWED_TELEGRAM_USER_IDS = "1";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "1";
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  process.env.DRY_RUN = "true";

  const { resetConfigForTests, loadConfig } = await import("../src/config.js");
  resetConfigForTests();
  loadConfig({ requireTelegram: false });

  const { createConfirm, resetConfirmStoreForTests } = await import("../src/engine/confirm.js");
  resetConfirmStoreForTests();
  const c = createConfirm({
    purpose: "reshape",
    summary: "test reshape",
    payload: { pool: "x", position: "y" },
  });
  assert.equal(c.purpose, "reshape");

  const analysis = {
    pool: "Pool1111111111111111111111111111111111111",
    position: "Pos11111111111111111111111111111111111111",
    mintX: "Token1111111111111111111111111111111111111",
    mintY: "So11111111111111111111111111111111111111112",
    solSide: "y" as const,
    tokenMint: "Token1111111111111111111111111111111111111",
    tokenDecimals: 6,
    solDecimals: 9,
    activeBinId: 1000,
    tokenBins: [{ binId: 990, kind: "token_only", tokenUi: 1, solUi: 0, tokenUsd: 1 }],
    tokenRanges: [{ from: 990, to: 990 }],
    bothBinCount: 0,
    totalTokenUi: 1,
    totalTokenUsd: 1,
    totalSolInTokenBinsUi: 0,
    feeTokenUi: 0,
    feeSolUi: 0,
    feeTokenUsd: 0,
    feeSolUsd: 0,
    estimatedReaddUi: 1,
    estimatedReaddUsd: 1,
    defaultWidth: 1,
    noteBothBins: "Tidak ada bin campuran.",
  };
  const { executeReshape } = await import("../src/engine/reshape.js");
  const r = await executeReshape({
    poolAddress: analysis.pool,
    positionAddress: analysis.position,
    strategyId: "bid_ask",
    width: 1,
    analysis: analysis as never,
  });
  assert.equal(r.success, true);
  assert.equal(r.dryRun, true);
  assert.ok(r.steps.some((s) => s.step === "claim" && /Skip claim/i.test(s.detail)));
  assert.ok(r.steps.some((s) => s.step === "withdraw"));
  assert.ok(r.steps.some((s) => s.step === "readd"));
  assert.ok(r.signatures.some((s) => s.startsWith("DRY_RUN")));
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  clampSlippagePct,
  coerceSlippagePct,
  jupiterSlippageBps,
  meteoraSlippagePct,
  SLIPPAGE_MAX_PCT,
} from "../src/engine/slippage.js";
import { detectMintAddress, isLikelyMintPaste } from "../src/engine/mint-detect.js";

test("Meteora slippage is percentage; Jupiter converts to bps", () => {
  // SDK: amount * (100+slippage)/100 → 10 means 10%, NOT 1000 bps
  assert.equal(meteoraSlippagePct(10), 10);
  assert.equal(jupiterSlippageBps(10), 1000);
  assert.equal(jupiterSlippageBps(0.5), 50);
  assert.throws(() => clampSlippagePct(0), /0\.1/);
  assert.throws(() => clampSlippagePct(SLIPPAGE_MAX_PCT + 1), /50/);
  assert.equal(coerceSlippagePct(999, 10), 50);
});

test("detectMintAddress validates PublicKey", () => {
  const kp = Keypair.generate();
  const mint = kp.publicKey.toBase58();
  assert.equal(detectMintAddress(mint), mint);
  assert.equal(isLikelyMintPaste(mint), true);
  assert.equal(detectMintAddress("not-a-mint"), null);
  assert.equal(detectMintAddress("So11111111111111111111111111111111111111112"), "So11111111111111111111111111111111111111112");
  assert.equal(detectMintAddress("hi " + mint), null); // must be whole message
});

test("settings persist slippage pct", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dlmm-set-"));
  process.env.DLMM_SKIP_ENV_CHMOD = "1";
  process.env.DATA_DIR = dir;
  process.env.ALLOWED_TELEGRAM_USER_IDS = "1";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "1";
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  process.env.SWAP_SLIPPAGE_PCT = "10";
  process.env.LIQ_SLIPPAGE_PCT = "10";
  process.env.DRY_RUN = "true";

  const { resetConfigForTests, loadConfig } = await import("../src/config.js");
  resetConfigForTests();
  loadConfig({ requireTelegram: false });
  const { setSwapSlippagePct, setLiqSlippagePct, getSwapSlippagePct, getLiqSlippagePct } =
    await import("../src/engine/slippage.js");
  setSwapSlippagePct(2.5);
  setLiqSlippagePct(5);
  assert.equal(getSwapSlippagePct(), 2.5);
  assert.equal(getLiqSlippagePct(), 5);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.equal(raw.swapSlippagePct, 2.5);
  assert.equal(raw.liqSlippagePct, 5);
});

test("zapout DRY_RUN with analysis; over-cap warns but does not throw", async () => {
  process.env.DLMM_SKIP_ENV_CHMOD = "1";
  process.env.ALLOWED_TELEGRAM_USER_IDS = "1";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "1";
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  process.env.DRY_RUN = "true";
  process.env.MAX_SWAP_USD = "100";
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dlmm-zap-"));

  const { resetConfigForTests, loadConfig } = await import("../src/config.js");
  resetConfigForTests();
  loadConfig({ requireTelegram: false });

  const analysis = {
    pool: "Pool1111111111111111111111111111111111111",
    position: "Pos11111111111111111111111111111111111111",
    mintX: "Token1111111111111111111111111111111111111",
    mintY: "So11111111111111111111111111111111111111112",
    solSide: "y" as const,
    tokenMint: "Token1111111111111111111111111111111111111",
    tokenDecimals: 6,
    totalValueUsd: 250,
    unclaimedFeesUsd: 1,
    feeTokenUi: 0,
    feeSolUi: 0,
    estTokenOutUi: 10,
    estTokenOutUsd: 250,
    swapSlippagePct: 10,
    warnOverCap: null,
  };
  const { executeZapout } = await import("../src/engine/zapout.js");
  const { createConfirm, resetConfirmStoreForTests } = await import("../src/engine/confirm.js");
  resetConfirmStoreForTests();
  createConfirm({ purpose: "zapout", summary: "z", payload: {} });

  const r = await executeZapout({
    poolAddress: analysis.pool,
    positionAddress: analysis.position,
    analysis: analysis as never,
  });
  assert.equal(r.success, true);
  assert.equal(r.dryRun, true);
  assert.ok(r.steps.some((s) => s.step === "claim"));
  assert.ok(r.steps.some((s) => s.step === "remove_close"));
  assert.ok(r.steps.some((s) => s.step === "swap"));
  assert.match(r.message, /over|DRY RUN/i);
});

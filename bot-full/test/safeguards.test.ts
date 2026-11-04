import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function freshTestKey(): string {
  return bs58.encode(Keypair.generate().secretKey);
}

test("redactSecrets hides private key and long base58", async () => {
  const secret = freshTestKey();
  process.env.WALLET_PRIVATE_KEY = secret;
  const { redactSecrets } = await import("../src/logger.js");
  const out = redactSecrets(`leak=${secret} ok`);
  assert.equal(out.includes(secret), false);
  assert.match(out, /REDACTED/);
  const blob = redactSecrets(`sig ${"9".repeat(70)} end`);
  assert.match(blob, /REDACTED:base58/);
});

test("checkEnvFilePermissions requires mode 600", async () => {
  const { checkEnvFilePermissions } = await import("../src/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dlmm-env-"));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "X=1\n");
  fs.chmodSync(envPath, 0o644);
  const bad = checkEnvFilePermissions(envPath);
  assert.equal(bad.ok, false);
  assert.match(String(bad.reason), /600/);
  fs.chmodSync(envPath, 0o600);
  const good = checkEnvFilePermissions(envPath);
  assert.equal(good.ok, true);
  assert.equal(good.mode, 0o600);
});

test("whitelist: only ALLOWED_TELEGRAM_USER_IDS authorized", async () => {
  process.env.DLMM_SKIP_ENV_CHMOD = "1";
  process.env.ALLOWED_TELEGRAM_USER_IDS = "111,222";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "999";
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  process.env.WALLET_PRIVATE_KEY = freshTestKey();
  process.env.DRY_RUN = "true";
  process.env.MAX_SWAP_USD = "100";

  const { resetConfigForTests, loadConfig } = await import("../src/config.js");
  resetConfigForTests();
  loadConfig({ requireTelegram: false });
  const { isAuthorized } = await import("../src/telegram/auth.js");

  const mk = (uid: number, chatId = 999) =>
    ({
      from: { id: uid },
      chat: { id: chatId, type: "private" },
    }) as never;

  assert.equal(isAuthorized(mk(111)), true);
  assert.equal(isAuthorized(mk(222)), true);
  assert.equal(isAuthorized(mk(333)), false);
  assert.equal(isAuthorized(mk(111, 12345)), false); // wrong chat
});

test("assertUsdCap: only MAX_SWAP_USD remains; no position cap", async () => {
  process.env.DLMM_SKIP_ENV_CHMOD = "1";
  process.env.ALLOWED_TELEGRAM_USER_IDS = "1";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "1";
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  process.env.WALLET_PRIVATE_KEY = freshTestKey();
  process.env.MAX_SWAP_USD = "100";
  process.env.DRY_RUN = "true";

  const { resetConfigForTests, loadConfig } = await import("../src/config.js");
  resetConfigForTests();
  loadConfig({ requireTelegram: false });
  const { assertUsdCap } = await import("../src/engine/executor.js");

  assert.doesNotThrow(() => assertUsdCap("swap", 50));
  assert.equal("maxPositionUsd" in loadConfig({ requireTelegram: false }), false);
  assert.throws(() => assertUsdCap("swap", 250), /Ditolak.*SWAP/);
});

test("confirm flow: create, cancel, expire, confirm take", async () => {
  const {
    createConfirm,
    takeAwaiting,
    cancelConfirm,
    getConfirm,
    resetConfirmStoreForTests,
  } = await import("../src/engine/confirm.js");
  resetConfirmStoreForTests();

  const a = createConfirm({
    purpose: "swap",
    summary: "test",
    payload: { x: 1 },
    ttlMs: 60_000,
  });
  assert.equal(takeAwaiting(a.id)?.status, "awaiting");
  assert.equal(cancelConfirm(a.id), true);
  assert.equal(getConfirm(a.id), null); // cancelled entries are removed
  assert.equal(cancelConfirm(a.id), false);

  const b = createConfirm({
    purpose: "add",
    summary: "expire-me",
    payload: {},
    ttlMs: 1,
  });
  await new Promise((r) => setTimeout(r, 5));
  const expired = takeAwaiting(b.id);
  assert.equal(expired?.status, "expired");
});

test("DRY_RUN executePendingTxs does not need network send", async () => {
  process.env.DLMM_SKIP_ENV_CHMOD = "1";
  process.env.ALLOWED_TELEGRAM_USER_IDS = "1";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "1";
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  process.env.WALLET_PRIVATE_KEY = freshTestKey();
  process.env.DRY_RUN = "true";

  const { resetConfigForTests, loadConfig } = await import("../src/config.js");
  resetConfigForTests();
  loadConfig({ requireTelegram: false });
  const { executePendingTxs } = await import("../src/engine/executor.js");
  const { Transaction, SystemProgram, PublicKey } = await import("@solana/web3.js");
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: loadConfig({ requireTelegram: false }).walletPublicKey, toPubkey: PublicKey.default, lamports: 1 }),
  );
  tx.feePayer = loadConfig({ requireTelegram: false }).walletPublicKey;
  tx.recentBlockhash = "11111111111111111111111111111111";
  const r = await executePendingTxs([
    { serialized: tx.serialize({ requireAllSignatures: false }).toString("base64"), encoding: "legacy", label: "dummy" },
  ]);
  assert.equal(r.success, true);
  assert.equal(r.dryRun, true);
  assert.match(r.signatures[0], /DRY_RUN/);
});

test("loadConfig derives public key and defaults DRY_RUN true", async () => {
  process.env.DLMM_SKIP_ENV_CHMOD = "1";
  const kp = Keypair.generate();
  process.env.WALLET_PRIVATE_KEY = bs58.encode(kp.secretKey);
  process.env.ALLOWED_TELEGRAM_USER_IDS = "42";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "1";
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  delete process.env.DRY_RUN;

  const { resetConfigForTests, loadConfig } = await import("../src/config.js");
  resetConfigForTests();
  const cfg = loadConfig({ requireTelegram: false });
  assert.equal(cfg.walletPublicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(cfg.dryRun, true);
  assert.equal("maxPositionUsd" in cfg, false);
  assert.equal(cfg.maxSwapUsd, 100);
});

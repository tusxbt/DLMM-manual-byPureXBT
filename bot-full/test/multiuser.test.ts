import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-"));
process.env.DATA_DIR = dir;
process.env.ALLOWED_TELEGRAM_USER_IDS = "111";
delete process.env.OWNER_TELEGRAM_ID;
process.env.TELEGRAM_CHAT_ID = "111";
process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.WALLET_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const store = await import("../src/users/store.js");
const { runAsUser } = await import("../src/users/context.js");
const { encryptSecret, decryptSecret, encryptionKey } = await import("../src/users/crypto.js");
const { getWallet } = await import("../src/engine/wallet.js");
const { loadConfig, resetConfigForTests } = await import("../src/config.js");
const { createConfirm, getConfirm, resetConfirmStoreForTests } = await import("../src/engine/confirm.js");
const { getSession } = await import("../src/telegram/session.js");
const { roleFor } = await import("../src/telegram/auth.js");
resetConfigForTests();

const owner = { userId: "111", isOwner: true };
const alice = { userId: "222", isOwner: false };
const bob = { userId: "333", isOwner: false };

test("encryption roundtrip + tamper + key formats", () => {
  const k = encryptionKey()!;
  const s = Keypair.generate().secretKey;
  const b = encryptSecret(s, k);
  assert.deepEqual(Buffer.from(decryptSecret(b, k)), Buffer.from(s));
  assert.throws(() => decryptSecret({ ...b, ct: Buffer.from("x".repeat(64)).toString("base64") }, k));
  assert.throws(() => decryptSecret(b, crypto.randomBytes(32)));
  assert.equal(encryptionKey(crypto.randomBytes(32).toString("base64"))?.length, 32);
  assert.equal(encryptionKey("short"), null);
});

test("access control: owner, admin-added user, removal, unknown denied", () => {
  const mk = (uid: number) => ({ from: { id: uid }, chat: { id: uid, type: "private" } }) as never;
  assert.equal(roleFor(mk(111)), "owner");
  assert.equal(roleFor(mk(222)), null);
  assert.throws(() => store.addUser("abc"));
  assert.equal(store.addUser("222"), true);
  assert.equal(store.addUser("222"), false);
  assert.equal(store.addUser("111"), false); // owner
  assert.equal(roleFor(mk(222)), "user");
  assert.ok(fs.existsSync(path.join(dir, "users.json")));
  store.addUser("333");
  store.removeUser("333");
  assert.equal(roleFor(mk(333)), null);
  store.addUser("333");
});

test("wallet create: encrypted on disk, 600, secret not in file", () => {
  const pk = store.createWallet("222");
  const f = path.join(dir, "wallets", "222.json");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const raw = fs.readFileSync(f, "utf8");
  store.resetUserStoreForTests();
  const kp = store.loadUserWallet("222");
  assert.equal(kp.publicKey.toBase58(), pk);
  assert.ok(!raw.includes(bs58.encode(kp.secretKey)));
  assert.ok(!raw.includes(JSON.stringify(Array.from(kp.secretKey))));
  assert.throws(() => store.createWallet("222"));
});

test("refuses wallet creation without encryption key", () => {
  const k = process.env.WALLET_ENCRYPTION_KEY;
  delete process.env.WALLET_ENCRYPTION_KEY;
  assert.throws(() => store.createWallet("999"), /WALLET_ENCRYPTION_KEY/);
  process.env.WALLET_ENCRYPTION_KEY = k;
});

test("import from VPS file: array + base58, plaintext shredded", () => {
  fs.mkdirSync(path.join(dir, "wallets", "import"), { recursive: true });
  const kp = Keypair.generate();
  fs.writeFileSync(store.importFile("333"), JSON.stringify(Array.from(kp.secretKey)));
  assert.equal(store.importWalletFromFile("333"), kp.publicKey.toBase58());
  assert.equal(fs.existsSync(store.importFile("333")), false);
  const kp2 = Keypair.generate();
  fs.writeFileSync(store.importFile("444"), bs58.encode(kp2.secretKey));
  assert.equal(store.importWalletFromFile("444"), kp2.publicKey.toBase58());
  fs.writeFileSync(store.importFile("555"), "garbage");
  assert.throws(() => store.importWalletFromFile("555"));
  assert.ok(fs.existsSync(store.importFile("555"))); // not deleted on failure
});

test("isolation: wallet, data dir, session, confirms per user", () => {
  const ownerPk = runAsUser(owner, () => getWallet().publicKey.toBase58());
  const aPk = runAsUser(alice, () => getWallet().publicKey.toBase58());
  const bPk = runAsUser(bob, () => getWallet().publicKey.toBase58());
  assert.equal(new Set([ownerPk, aPk, bPk]).size, 3);
  assert.equal(runAsUser(alice, () => loadConfig({ requireTelegram: false }).walletPublicKey.toBase58()), aPk);
  const dA = runAsUser(alice, () => loadConfig({ requireTelegram: false }).dataDir);
  const dO = runAsUser(owner, () => loadConfig({ requireTelegram: false }).dataDir);
  assert.notEqual(dA, dO);
  assert.ok(dA.includes(path.join("users", "222")));
  // user without wallet never falls back to owner's wallet
  store.addUser("666");
  assert.throws(() => runAsUser({ userId: "666", isOwner: false }, () => getWallet()));
  // sessions
  runAsUser(alice, () => (getSession("chat").data.posPage = 7));
  assert.equal(runAsUser(bob, () => getSession("chat").data.posPage), undefined);
  // confirms
  resetConfirmStoreForTests();
  const req = runAsUser(alice, () => createConfirm({ purpose: "remove", summary: "x", payload: {} }));
  assert.equal(runAsUser(bob, () => getConfirm(req.id)), null);
  assert.equal(runAsUser(owner, () => getConfirm(req.id)), null);
  assert.ok(runAsUser(alice, () => getConfirm(req.id)));
});

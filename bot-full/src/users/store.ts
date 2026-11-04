/** users.json + encrypted per-user wallets. Secrets never logged / returned to chat. */
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { encryptionKey, encryptSecret, decryptSecret, type EncBlob } from "./crypto.js";

export function rootDataDir(): string {
  return process.env.DATA_DIR?.trim() || "./data";
}

function envAllowed(): string[] {
  return (process.env.ALLOWED_TELEGRAM_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function ownerId(): string | null {
  return process.env.OWNER_TELEGRAM_ID?.trim() || envAllowed()[0] || null;
}

type UsersFile = { users: Array<{ id: string; addedAt: string }> };
const usersFile = () => path.join(rootDataDir(), "users.json");

export function listUsers(): UsersFile["users"] {
  try {
    return (JSON.parse(fs.readFileSync(usersFile(), "utf8")) as UsersFile).users || [];
  } catch {
    return [];
  }
}
function saveUsers(users: UsersFile["users"]): void {
  fs.mkdirSync(rootDataDir(), { recursive: true });
  const tmp = usersFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, usersFile());
}
export function addUser(id: string): boolean {
  if (!/^\d{3,20}$/.test(id)) throw new Error("User ID harus angka Telegram");
  if (id === ownerId()) return false;
  const u = listUsers();
  if (u.some((x) => x.id === id)) return false;
  u.push({ id, addedAt: new Date().toISOString() });
  saveUsers(u);
  return true;
}
/** Removes access only; the encrypted wallet file is kept (funds stay recoverable). */
export function removeUser(id: string): boolean {
  const u = listUsers();
  const n = u.filter((x) => x.id !== id);
  if (n.length === u.length) return false;
  saveUsers(n);
  walletCache.delete(id);
  return true;
}

export type Role = "owner" | "user" | null;
export function roleOf(id: string | undefined | null): Role {
  if (!id) return null;
  if (id === ownerId()) return "owner";
  if (envAllowed().includes(id) || listUsers().some((x) => x.id === id)) return "user";
  return null;
}

// ── wallets ──
const walletsDir = () => path.join(rootDataDir(), "wallets");
const walletFile = (id: string) => path.join(walletsDir(), `${id}.json`);
export const importFile = (id: string) => path.join(walletsDir(), "import", `${id}.json`);
const walletCache = new Map<string, Keypair>();

type WalletFile = { userId: string; pubkey: string; createdAt: string; source: "generated" | "import"; enc: EncBlob };

export function walletPubkeyOf(id: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(walletFile(id), "utf8")) as WalletFile).pubkey;
  } catch {
    return null;
  }
}
export function hasWallet(id: string): boolean {
  return walletPubkeyOf(id) != null;
}

export const NO_KEY_MSG =
  "WALLET_ENCRYPTION_KEY belum diset. Owner: buat key dengan `openssl rand -hex 32`, tambahkan `WALLET_ENCRYPTION_KEY=<hasil>` ke .env (chmod 600), lalu restart bot. Backup key ini — tanpa key, wallet user tidak bisa dibuka.";

function requireKey(): Buffer {
  const k = encryptionKey();
  if (!k) throw new Error(NO_KEY_MSG);
  return k;
}

function writeWallet(id: string, kp: Keypair, source: WalletFile["source"]): void {
  const key = requireKey();
  fs.mkdirSync(walletsDir(), { recursive: true, mode: 0o700 });
  const data: WalletFile = { userId: id, pubkey: kp.publicKey.toBase58(), createdAt: new Date().toISOString(), source, enc: encryptSecret(kp.secretKey, key) };
  const tmp = walletFile(id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, walletFile(id));
  fs.chmodSync(walletFile(id), 0o600);
  walletCache.set(id, kp);
}

export function createWallet(id: string): string {
  if (hasWallet(id)) throw new Error("Wallet sudah ada");
  requireKey();
  const kp = Keypair.generate();
  writeWallet(id, kp, "generated");
  return kp.publicKey.toBase58();
}

export function loadUserWallet(id: string): Keypair {
  const c = walletCache.get(id);
  if (c) return c;
  let wf: WalletFile;
  try {
    wf = JSON.parse(fs.readFileSync(walletFile(id), "utf8"));
  } catch {
    throw new Error("Wallet belum dibuat — buka 👛 Wallet → 🆕 Buat wallet");
  }
  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(decryptSecret(wf.enc, requireKey()));
  } catch (e) {
    if ((e as Error).message === NO_KEY_MSG) throw e;
    throw new Error("Gagal dekripsi wallet — WALLET_ENCRYPTION_KEY salah?");
  }
  if (kp.publicKey.toBase58() !== wf.pubkey) throw new Error("Wallet file korup (pubkey mismatch)");
  walletCache.set(id, kp);
  return kp;
}

function parseKeyFile(raw: string): Keypair {
  const t = raw.trim();
  let secret: Uint8Array;
  if (t.startsWith("[")) secret = Uint8Array.from(JSON.parse(t) as number[]);
  else secret = bs58.decode(t.replace(/^"|"$/g, ""));
  if (secret.length !== 64) throw new Error("format key tidak valid (harus array 64 byte atau base58)");
  return Keypair.fromSecretKey(secret);
}

function shred(file: string): void {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r+");
    fs.writeSync(fd, Buffer.alloc(size, 0), 0, size, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function hasImportFile(id: string): boolean {
  return fs.existsSync(importFile(id));
}

/** Owner-only: encrypt DATA_DIR/wallets/import/<id>.json into the user's wallet, then shred the plaintext. */
export function importWalletFromFile(id: string, opts: { overwrite?: boolean } = {}): string {
  requireKey();
  const f = importFile(id);
  if (!fs.existsSync(f)) throw new Error(`File tidak ada: ${f}`);
  if (hasWallet(id) && !opts.overwrite) throw new Error("User sudah punya wallet — hapus/backup dulu file wallet lamanya");
  let kp: Keypair;
  try {
    kp = parseKeyFile(fs.readFileSync(f, "utf8"));
  } catch (e) {
    throw new Error(`Import gagal: ${(e as Error).message.includes("format") ? (e as Error).message : "format key tidak valid"}`);
  }
  writeWallet(id, kp, "import");
  // verify roundtrip before destroying plaintext
  walletCache.delete(id);
  if (loadUserWallet(id).publicKey.toBase58() !== kp.publicKey.toBase58()) throw new Error("verifikasi gagal, file import tidak dihapus");
  shred(f);
  return kp.publicKey.toBase58();
}

export function resetUserStoreForTests(): void {
  walletCache.clear();
}

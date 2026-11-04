/**
 * Wallet keypair loader. Private key is read ONLY from process.env.WALLET_PRIVATE_KEY
 * (populated via dotenv from .env). Never log, print, or serialize the secret.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

let _wallet: Keypair | null = null;

export function getWallet(): Keypair {
  if (_wallet) return _wallet;
  const raw = process.env.WALLET_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error("WALLET_PRIVATE_KEY tidak diset di .env");
  }
  if (/^(base58|placeholder|your-|xxx)/i.test(raw) || raw.includes("PLACEHOLDER")) {
    throw new Error("WALLET_PRIVATE_KEY masih placeholder — isi key wallet terpisah (dana kecil) di .env");
  }
  try {
    const secret = bs58.decode(raw);
    _wallet = Keypair.fromSecretKey(secret);
  } catch {
    throw new Error("WALLET_PRIVATE_KEY tidak valid (harus base58 secret key Solana)");
  }
  return _wallet;
}

export function getWalletPublicKey(): PublicKey {
  return getWallet().publicKey;
}

export function resetWalletForTests(): void {
  _wallet = null;
}

/** Derive public address without caching — for validation only. Does not log. */
export function publicKeyFromPrivateKeyEnv(): string {
  return getWallet().publicKey.toBase58();
}

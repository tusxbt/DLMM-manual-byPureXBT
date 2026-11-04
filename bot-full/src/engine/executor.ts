/**
 * Sign + send transactions with the local wallet keypair.
 * Respects DRY_RUN. Never logs secrets.
 */
import {
  Transaction,
  VersionedTransaction,
  type Signer,
} from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { log } from "../logger.js";
import { getConnection } from "./connection.js";
import { getWallet } from "./wallet.js";
import type { PendingTxItem } from "./pending.js";

export type ExecResult = {
  success: boolean;
  dryRun?: boolean;
  signatures: string[];
  error?: string;
  message?: string;
  /** ms per tx (send → confirmed) */
  timings?: number[];
  /** labels of txs that landed (in order) — used for partial multi-tx deploy state */
  landedLabels?: string[];
};

export function assertUsdCap(kind: "position" | "swap", usd: number): void {
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const cap = kind === "position" ? cfg.maxPositionUsd : cfg.maxSwapUsd;
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`Nilai USD tidak valid: ${usd}`);
  }
  if (usd > cap) {
    throw new Error(
      `Ditolak: ${kind === "position" ? "posisi" : "swap"} ${usd.toFixed(2)} USD > batas MAX_${kind === "position" ? "POSITION" : "SWAP"}_USD=${cap}`,
    );
  }
}

/**
 * Pre-send check: every required signer in the message header has a valid signature.
 * Throws a clear (Indonesian) error listing missing signer pubkeys.
 */
export function assertAllSigned(
  tx: Transaction | VersionedTransaction,
  label = "tx",
  ignore: string[] = [],
): void {
  let missing: string[] = [];
  if (tx instanceof VersionedTransaction) {
    const n = tx.message.header.numRequiredSignatures;
    const keys = tx.message.staticAccountKeys;
    for (let i = 0; i < n; i++) {
      const sig = tx.signatures[i];
      if (!sig || sig.every((b) => b === 0)) missing.push(keys[i].toBase58());
    }
  } else {
    const msg = tx.compileMessage();
    const n = msg.header.numRequiredSignatures;
    for (let i = 0; i < n; i++) {
      const pk = msg.accountKeys[i];
      const entry = tx.signatures.find((s) => s.publicKey.equals(pk));
      if (!entry?.signature || entry.signature.every((b) => b === 0)) missing.push(pk.toBase58());
    }
    if (!missing.length && !ignore.length && !tx.verifySignatures(true)) {
      throw new Error(`Tanda tangan ${label} tidak valid (pesan berubah setelah ditandatangani?).`);
    }
  }
  missing = missing.filter((m) => !ignore.includes(m));
  if (missing.length) {
    throw new Error(`Signer kurang untuk ${label}: ${missing.join(", ")} — tx tidak dikirim.`);
  }
}

/**
 * Sign a deserialized legacy tx WITHOUT wiping existing partial signatures
 * (e.g. the ephemeral position keypair) and without touching the blockhash.
 */
export function signLegacyPreserving(tx: Transaction, signers: Signer[]): Transaction {
  const needed = new Set(tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures).map((k) => k.toBase58()));
  const use = signers.filter((s) => needed.has(s.publicKey.toBase58()));
  if (use.length) tx.partialSign(...use);
  return tx;
}

export async function executePendingTxs(
  items: PendingTxItem[],
  extraSigners: Signer[] = [],
  opts: { onProgress?: (done: number, total: number, label: string) => void | Promise<void> } = {},
): Promise<ExecResult> {
  const cfg = loadConfig({ requireTelegram: false });
  if (cfg.dryRun) {
    // Still verify that every non-wallet signer (e.g. position keypair) already signed.
    const walletPk = cfg.walletPublicKey.toBase58();
    for (const item of items) {
      const buf = Buffer.from(item.serialized, "base64");
      const tx = item.encoding === "versioned" ? VersionedTransaction.deserialize(buf) : Transaction.from(buf);
      try {
        assertAllSigned(tx, item.label, [walletPk, ...extraSigners.map((x) => x.publicKey.toBase58())]);
      } catch (e) {
        return { success: false, dryRun: true, signatures: [], error: (e as Error).message };
      }
    }
    log("exec", `DRY_RUN — skip send (${items.length} tx)`);
    return {
      success: true,
      dryRun: true,
      signatures: items.map((_, i) => `DRY_RUN_SIG_${i + 1}`),
      message: `DRY RUN — ${items.length} tx tidak dikirim. Set DRY_RUN=false di .env untuk eksekusi nyata.`,
    };
  }

  const wallet = getWallet();
  const signatures: string[] = [];
  const timings: number[] = [];
  const landedLabels: string[] = [];

  try {
    for (const item of items) {
      const t = Date.now();
      const sig = await sendWithRetry(item, [wallet, ...extraSigners, ...(item.coSigners || [])]);
      timings.push(Date.now() - t);
      signatures.push(sig);
      landedLabels.push(item.label);
      if (opts.onProgress && items.length > 1) {
        try {
          await opts.onProgress(signatures.length, items.length, item.label);
        } catch {
          /* UI only */
        }
      }
    }
    return { success: true, signatures, timings, landedLabels };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    log("exec", `failed: ${msg}`, "error");
    return { success: false, signatures, error: msg, timings, landedLabels };
  }
}

export const MAX_SEND_ATTEMPTS = 3; // first try + 2 automatic rebuilds on expiry
const REBROADCAST_MS = 2000;

type Sendable = { tx: Transaction | VersionedTransaction; raw: Buffer; blockhash: string; lastValid: number };

/** Deserialize, put a FRESH blockhash, sign with all available signers, verify signers. */
export function prepareTx(
  item: PendingTxItem,
  signers: Signer[],
  fresh: { blockhash: string; lastValidBlockHeight: number },
): Sendable {
  const buf = Buffer.from(item.serialized, "base64");
  if (item.encoding === "versioned") {
    const tx = VersionedTransaction.deserialize(buf);
    const n = tx.message.header.numRequiredSignatures;
    const needed = tx.message.staticAccountKeys.slice(0, n).map((k) => k.toBase58());
    const have = new Set(signers.map((s) => s.publicKey.toBase58()));
    const canRefresh = needed.every((k) => have.has(k));
    if (canRefresh) {
      tx.message.recentBlockhash = fresh.blockhash;
      tx.signatures = needed.map(() => new Uint8Array(64));
    }
    const use = signers.filter((s) => needed.includes(s.publicKey.toBase58()));
    if (use.length) tx.sign(use);
    assertAllSigned(tx, item.label);
    return {
      tx,
      raw: Buffer.from(tx.serialize()),
      blockhash: tx.message.recentBlockhash,
      lastValid: canRefresh ? fresh.lastValidBlockHeight : Number.MAX_SAFE_INTEGER,
    };
  }
  const tx = Transaction.from(buf);
  const msg = tx.compileMessage();
  const needed = msg.accountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
  const have = new Set(signers.map((s) => s.publicKey.toBase58()));
  const canRefresh = needed.every((k) => have.has(k));
  if (canRefresh) {
    // NOTE: never use sendAndConfirmTransaction / tx.sign on a tx with partial sigs we can't
    // reproduce — here we hold ALL signers, so a full re-sign with a fresh blockhash is safe.
    tx.recentBlockhash = fresh.blockhash;
    tx.signatures = [];
    tx.feePayer = tx.feePayer ?? signers[0].publicKey;
    tx.sign(...signers.filter((s) => needed.includes(s.publicKey.toBase58())));
  } else {
    signLegacyPreserving(tx, signers);
  }
  assertAllSigned(tx, item.label);
  return {
    tx,
    raw: tx.serialize(),
    blockhash: tx.recentBlockhash!,
    lastValid: canRefresh ? fresh.lastValidBlockHeight : Number.MAX_SAFE_INTEGER,
  };
}

async function sendWithRetry(item: PendingTxItem, signers: Signer[]): Promise<string> {
  const conn = getConnection();
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    const fresh = await conn.getLatestBlockhash("confirmed");
    const s = prepareTx(item, signers, fresh);
    const lastValid = s.lastValid === Number.MAX_SAFE_INTEGER ? fresh.lastValidBlockHeight : s.lastValid;
    const sig = await conn.sendRawTransaction(s.raw, { skipPreflight: false, maxRetries: 0, preflightCommitment: "confirmed" });
    log("exec", `sent ${item.label} try=${attempt} sig=${sig.slice(0, 12)}…`);
    const outcome = await waitLanded(sig, s.raw, lastValid);
    if (outcome === "ok") return sig;
    if (typeof outcome === "object") throw new Error(`Tx ${item.label} gagal on-chain: ${JSON.stringify(outcome.err)}`);
    lastErr = `blockhash kadaluarsa (try ${attempt})`;
    log("exec", `${item.label} expired, ${attempt < MAX_SEND_ATTEMPTS ? "rebuild + retry" : "menyerah"}`, "warn");
    if (s.lastValid === Number.MAX_SAFE_INTEGER) break; // cannot re-sign → no safe retry
  }
  throw new Error(`Tx ${item.label} tidak masuk: ${lastErr}. Cek wallet/posisi sebelum ulang.`);
}

/** Rebroadcast until confirmed, failed, or block height passes lastValid (then final status check). */
async function waitLanded(sig: string, raw: Buffer, lastValid: number): Promise<"ok" | "expired" | { err: unknown }> {
  const conn = getConnection();
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) return { err: st.err };
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return "ok";
    const height = await conn.getBlockHeight("confirmed");
    if (height > lastValid) {
      const fin = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (fin?.err) return { err: fin.err };
      if (fin && fin.confirmationStatus) return "ok";
      return "expired";
    }
    try {
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    } catch {
      /* rebroadcast best-effort */
    }
    await new Promise((r) => setTimeout(r, REBROADCAST_MS));
  }
}

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
  const conn = getConnection();
  const signatures: string[] = [];

  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const buf = Buffer.from(item.serialized, "base64");
      if (item.encoding === "versioned") {
        const tx = VersionedTransaction.deserialize(buf);
        // VersionedTransaction.sign only fills the given signers' slots; existing sigs kept
        const needed = new Set(
          tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58()),
        );
        const use = [wallet, ...extraSigners].filter((s) => needed.has(s.publicKey.toBase58()));
        if (use.length) tx.sign(use);
        assertAllSigned(tx, item.label);
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
        await conn.confirmTransaction(
          {
            signature: sig,
            blockhash: tx.message.recentBlockhash,
            lastValidBlockHeight: (await conn.getLatestBlockhash("confirmed")).lastValidBlockHeight,
          },
          "confirmed",
        );
        signatures.push(sig);
        log("exec", `sent versioned ${item.label} sig=${sig.slice(0, 12)}…`);
      } else {
        // NOTE: sendAndConfirmTransaction(conn, tx, signers) re-fetches the blockhash and calls
        // tx.sign(), which WIPES pre-existing partial signatures (position keypair). Root cause
        // of "Missing signature for public key". Use partialSign + sendRawTransaction instead.
        const tx = Transaction.from(buf);
        signLegacyPreserving(tx, [wallet, ...extraSigners]);
        assertAllSigned(tx, item.label);
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
        const latest = await conn.getLatestBlockhash("confirmed");
        const res = await conn.confirmTransaction(
          { signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: latest.lastValidBlockHeight },
          "confirmed",
        );
        if (res.value.err) throw new Error(`Tx ${item.label} gagal on-chain: ${JSON.stringify(res.value.err)}`);
        signatures.push(sig);
        log("exec", `sent legacy ${item.label} sig=${sig.slice(0, 12)}…`);
      }
    }
    return { success: true, signatures };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    log("exec", `failed: ${msg}`, "error");
    return { success: false, signatures, error: msg };
  }
}

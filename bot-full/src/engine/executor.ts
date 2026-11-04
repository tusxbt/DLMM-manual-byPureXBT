/**
 * Sign + send transactions with the local wallet keypair.
 * Respects DRY_RUN. Never logs secrets.
 */
import {
  sendAndConfirmTransaction,
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

export async function executePendingTxs(
  items: PendingTxItem[],
  extraSigners: Signer[] = [],
): Promise<ExecResult> {
  const cfg = loadConfig({ requireTelegram: false });
  if (cfg.dryRun) {
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
        tx.sign([wallet, ...extraSigners]);
        const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
        const latest = await conn.getLatestBlockhash("confirmed");
        await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
        signatures.push(sig);
        log("exec", `sent versioned ${item.label} sig=${sig.slice(0, 12)}…`);
      } else {
        const tx = Transaction.from(buf);
        const signers: Signer[] = [wallet, ...extraSigners];
        const sig = await sendAndConfirmTransaction(conn, tx, signers, {
          commitment: "confirmed",
        });
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

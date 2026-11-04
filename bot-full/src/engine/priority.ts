/**
 * Priority fees for faster landing. DLMM (legacy) txs: ComputeBudget setComputeUnitPrice.
 * Jupiter swaps: prioritizationFeeLamports with a max cap.
 */
import { ComputeBudgetProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { getConnection } from "./connection.js";
import { loadSettings } from "../store/settings.js";
import { log } from "../logger.js";

export const AUTO_MIN_MICRO = 50_000;
export const AUTO_MAX_MICRO = 2_000_000;

/** 75th percentile of non-zero samples, clamped. Pure for tests. */
export function pickAutoFee(samples: number[]): number {
  const nz = samples.filter((x) => x > 0).sort((a, b) => a - b);
  if (!nz.length) return AUTO_MIN_MICRO;
  const p75 = nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.75))];
  return Math.min(AUTO_MAX_MICRO, Math.max(AUTO_MIN_MICRO, p75));
}

let cache: { at: number; v: number } | null = null;

export async function getPriorityFeeMicroLamports(): Promise<number> {
  const fixed = loadSettings().priorityFeeMicroLamports;
  if (fixed > 0) return fixed;
  if (cache && Date.now() - cache.at < 10_000) return cache.v;
  try {
    const fees = await getConnection().getRecentPrioritizationFees();
    const v = pickAutoFee(fees.map((f) => f.prioritizationFee));
    cache = { at: Date.now(), v };
    return v;
  } catch (e) {
    log("priority", `auto fee failed: ${(e as Error).message}`, "warn");
    return AUTO_MIN_MICRO;
  }
}

function isComputeBudget(ix: TransactionInstruction): boolean {
  return ix.programId.equals(ComputeBudgetProgram.programId);
}

/** Set/replace setComputeUnitPrice. Must be called BEFORE any signing. */
export function applyPriorityFee(tx: Transaction, microLamports: number): Transaction {
  if (tx.signatures.some((s) => s.signature)) throw new Error("applyPriorityFee dipanggil setelah tx ditandatangani");
  const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  const idx = tx.instructions.findIndex((ix) => isComputeBudget(ix) && ix.data[0] === 3);
  if (idx >= 0) tx.instructions[idx] = price;
  else {
    // place after any existing compute-budget ixs (e.g. SetComputeUnitLimit from SDK)
    let at = 0;
    while (at < tx.instructions.length && isComputeBudget(tx.instructions[at])) at++;
    tx.instructions.splice(at, 0, price);
  }
  return tx;
}

export function jupiterPrioritization(): Record<string, unknown> | undefined {
  const max = loadSettings().jupPriorityMaxLamports;
  if (max <= 0) return undefined;
  return { priorityLevelWithMaxLamports: { maxLamports: max, priorityLevel: "veryHigh" } };
}

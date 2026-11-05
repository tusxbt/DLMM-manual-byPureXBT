/**
 * Robust token → SOL swap: quote + build + send, and on transient errors (blockhash not found,
 * expired, block height exceeded, simulation/RPC hiccups, 429) re-quote + rebuild with a fresh
 * blockhash and retry. Before every retry the wallet balance is re-read so a swap that actually
 * landed is never repeated (no double swap) and only the leftover is sold.
 */
import { SOL_MINT } from "../config.js";
import { log } from "../logger.js";
import type { PendingTxItem } from "./pending.js";

export type SwapDeps = {
  balance: (mint: string) => Promise<bigint>;
  quote: (mint: string, amountAtomic: string) => Promise<{ outAmount: string; inAmount?: string }>;
  build: (quote: unknown) => Promise<PendingTxItem>;
  send: (tx: PendingTxItem) => Promise<{ success: boolean; signatures: string[]; error?: string }>;
  sleep: (ms: number) => Promise<void>;
};

export const SWAP_MAX_ATTEMPTS = 4;
export const SWAP_BACKOFF_MS = [1500, 3000, 4500]; // ≈9s waits + tx time ≈ 10–15s total

const TRANSIENT =
  /blockhash not found|blockhash.*(expired|kadaluarsa)|block height exceeded|tidak masuk|simulation failed|transaction simulation|node is behind|timed? ?out|timeout|429|too many requests|fetch failed|ECONNRESET|socket hang up|503|502|minContextSlot|HTTP 5\d\d/i;
/** Program-level failures (slippage etc.) inside simulation are also worth a re-quote. */
export function isRetryableSwapError(msg: string | undefined): boolean {
  return !!msg && TRANSIENT.test(msg);
}

export type RobustSwapResult = {
  success: boolean;
  signatures: string[];
  attempts: number;
  soldAtomic: bigint;
  estOutLamports: bigint;
  error?: string;
  /** leftover token still in the wallet (when failed) */
  leftoverMint?: string;
};

/**
 * Sell `amountAtomic` of `mint` (≤ wallet balance). baseline = balance that must remain untouched
 * (balance before the swap − amount), so retries never sell tokens the user already held.
 */
export async function swapToSolRobust(
  mint: string,
  amountAtomic: bigint,
  deps: SwapDeps,
  opts: { maxAttempts?: number; backoffMs?: number[]; label?: string } = {},
): Promise<RobustSwapResult> {
  const max = opts.maxAttempts ?? SWAP_MAX_ATTEMPTS;
  const backoff = opts.backoffMs ?? SWAP_BACKOFF_MS;
  const sigs: string[] = [];
  if (mint === SOL_MINT || amountAtomic <= 0n) return { success: true, signatures: [], attempts: 0, soldAtomic: 0n, estOutLamports: 0n };
  const start = await deps.balance(mint);
  const baseline = start > amountAtomic ? start - amountAtomic : 0n;
  let amount = amountAtomic < start ? amountAtomic : start;
  let lastErr = "";
  let estOut = 0n;
  for (let attempt = 1; attempt <= max; attempt++) {
    if (attempt > 1) {
      await deps.sleep(backoff[Math.min(attempt - 2, backoff.length - 1)]);
      const bal = await deps.balance(mint);
      const left = bal - baseline;
      if (left <= 0n) {
        // the previous attempt landed after all → nothing left to sell, never swap twice
        log("swap", `${opts.label ?? mint.slice(0, 4)} retry ${attempt}: saldo sudah berkurang, swap sebelumnya masuk`);
        return { success: true, signatures: sigs, attempts: attempt - 1, soldAtomic: amount, estOutLamports: estOut };
      }
      amount = left;
    }
    if (amount <= 0n) return { success: true, signatures: sigs, attempts: attempt - 1, soldAtomic: 0n, estOutLamports: 0n };
    try {
      const q = await deps.quote(mint, amount.toString());
      estOut = BigInt(q.outAmount || "0");
      const tx = await deps.build(q);
      const r = await deps.send(tx);
      sigs.push(...(r.signatures || []));
      if (r.success) return { success: true, signatures: sigs, attempts: attempt, soldAtomic: amount, estOutLamports: estOut };
      lastErr = r.error || "swap gagal";
    } catch (e) {
      lastErr = (e as Error).message || String(e);
    }
    log("swap", `${opts.label ?? mint.slice(0, 4)} try ${attempt}/${max} gagal: ${lastErr.slice(0, 160)}`, "warn");
    if (!isRetryableSwapError(lastErr)) break;
  }
  return { success: false, signatures: sigs, attempts: max, soldAtomic: 0n, estOutLamports: 0n, error: lastErr, leftoverMint: mint };
}

/** Production deps (lazy imports keep this module test-friendly). */
export async function liveSwapDeps(): Promise<SwapDeps> {
  const { getWalletPublicKey } = await import("./wallet.js");
  const { getTokenBalanceAtomic } = await import("./reshape.js");
  const { getSwapQuote, buildSwapTx } = await import("./jupiter-swap.js");
  const { jupiterSlippageBps } = await import("./slippage.js");
  const { executePendingTxs } = await import("./executor.js");
  const user = getWalletPublicKey();
  return {
    balance: (m) => getTokenBalanceAtomic(m, user),
    quote: (m, a) => getSwapQuote({ inputMint: m, outputMint: SOL_MINT, amountAtomic: a, slippageBps: jupiterSlippageBps() }),
    build: (q) => buildSwapTx({ quote: q as never }),
    send: (tx) => executePendingTxs([tx]),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** 🔁 Retry swap: sell the WHOLE current wallet balance of mint → SOL (fresh quote). */
export async function retrySwapAll(mint: string, deps?: SwapDeps): Promise<RobustSwapResult> {
  const d = deps ?? (await liveSwapDeps());
  const bal = await d.balance(mint);
  if (bal <= 0n) return { success: true, signatures: [], attempts: 0, soldAtomic: 0n, estOutLamports: 0n };
  return swapToSolRobust(mint, bal, d, { label: "retry" });
}

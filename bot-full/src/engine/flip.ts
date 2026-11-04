/**
 * Flip (in place): withdraw ONLY the token-bearing (non-SOL) bins of a position, then add that exact
 * withdrawn token back into the SAME position as one-sided BidAsk on the token side of the active price
 * (above active when token is X, below when token is Y), within the position's own bin range.
 * Position account and SOL-only bins are kept. No swap, no close, no new position.
 */
import { PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { getConnection } from "./connection.js";
import { getDLMM } from "./dlmmSdk.js";
import { getWalletPublicKey } from "./wallet.js";
import { executePendingTxs } from "./executor.js";
import { loadConfig } from "../config.js";
import { meteoraSlippagePct } from "./slippage.js";
import { analyzeReshape, getTokenBalanceAtomic, serializeTx, withBlockhash, type ReshapeAnalysis } from "./reshape.js";
import { atomicToUi, classifyPositionBins, type BinAmounts } from "./reshape-math.js";
import type { PendingTxItem } from "./pending.js";

/** One addLiquidityByStrategy tx stays safe up to this many bins. */
export const FLIP_MAX_BINS = 69;

export type FlipTarget =
  | { ok: true; minBinId: number; maxBinId: number; bins: number; capped: boolean }
  | { ok: false; reason: string };

/** Pure: token-side target range inside the position [lower, upper]. */
export function planFlipRange(i: { activeBinId: number; lower: number; upper: number; tokenIsX: boolean }): FlipTarget {
  let lo: number;
  let hi: number;
  if (i.tokenIsX) {
    lo = Math.max(i.activeBinId + 1, i.lower);
    hi = i.upper;
    if (lo > hi)
      return { ok: false, reason: `Harga sudah di atas range posisi (active ${i.activeBinId} > max ${i.upper}) — tidak ada bin di atas harga untuk menampung token.` };
    let capped = false;
    if (hi - lo + 1 > FLIP_MAX_BINS) {
      hi = lo + FLIP_MAX_BINS - 1;
      capped = true;
    }
    return { ok: true, minBinId: lo, maxBinId: hi, bins: hi - lo + 1, capped };
  }
  lo = i.lower;
  hi = Math.min(i.activeBinId - 1, i.upper);
  if (lo > hi)
    return { ok: false, reason: `Harga sudah di bawah range posisi (active ${i.activeBinId} < min ${i.lower}) — tidak ada bin sisi token untuk menampung.` };
  let capped = false;
  if (hi - lo + 1 > FLIP_MAX_BINS) {
    lo = hi - FLIP_MAX_BINS + 1;
    capped = true;
  }
  return { ok: true, minBinId: lo, maxBinId: hi, bins: hi - lo + 1, capped };
}

export type FlipAnalysis = {
  base: ReshapeAnalysis | null;
  pool: string;
  position: string;
  poolName?: string;
  lower: number;
  upper: number;
  activeBinId: number;
  tokenUi: number;
  tokenUsd: number;
  /** SOL that comes back to wallet from mixed bins (not re-added) */
  solFromMixedUi: number;
  target: FlipTarget;
  empty: boolean;
};

export async function analyzeFlip(input: { poolAddress: string; positionAddress: string; poolName?: string }): Promise<FlipAnalysis> {
  const { DLMM } = await getDLMM();
  const pool = await DLMM.create(getConnection(), new PublicKey(input.poolAddress));
  const pos = await pool.getPosition(new PublicKey(input.positionAddress));
  const pd = pos.positionData as { lowerBinId: number; upperBinId: number };
  const active = (await pool.getActiveBin()).binId as number;
  let base: ReshapeAnalysis | null = null;
  try {
    base = await analyzeReshape(input);
  } catch (e) {
    if ((e as { code?: string }).code !== "NO_TOKEN_BINS") throw e;
  }
  const tokenIsX = pool.lbPair.tokenXMint.toBase58() !== "So11111111111111111111111111111111111111112";
  return {
    base,
    pool: input.poolAddress,
    position: input.positionAddress,
    poolName: input.poolName,
    lower: pd.lowerBinId,
    upper: pd.upperBinId,
    activeBinId: active,
    tokenUi: base?.totalTokenUi ?? 0,
    tokenUsd: base?.totalTokenUsd ?? 0,
    solFromMixedUi: base?.totalSolInTokenBinsUi ?? 0,
    target: planFlipRange({ activeBinId: active, lower: pd.lowerBinId, upper: pd.upperBinId, tokenIsX }),
    empty: !base || base.totalTokenUi <= 0,
  };
}

export type FlipResult = { success: boolean; signatures: string[]; message: string; error?: string };

export async function executeFlip(a: FlipAnalysis): Promise<FlipResult> {
  if (a.empty || !a.base) return { success: false, signatures: [], message: "Tidak ada token untuk di-flip.", error: "NO_TOKEN" };
  const cfg = loadConfig({ requireTelegram: false });
  if (cfg.dryRun) {
    const t = a.target.ok ? `[${a.target.minBinId},${a.target.maxBinId}]` : "-";
    return {
      success: true,
      signatures: ["DRY_RUN_flip_wd_1", "DRY_RUN_flip_add_1"],
      message: `DRY RUN flip — withdraw ${a.base.tokenRanges.length} range token ≈${a.tokenUi}, re-add BidAsk ke posisi sama bins ${t}.`,
    };
  }
  const user = getWalletPublicKey();
  const { DLMM, StrategyType } = await getDLMM();
  const pool = await DLMM.create(getConnection(), new PublicKey(a.pool));
  const posKey = new PublicKey(a.position);
  const tokenMint = a.base.tokenMint;
  const tokenIsX = a.base.solSide === "y";
  const sigs: string[] = [];

  // re-check target with the live active bin BEFORE touching anything
  const active = (await pool.getActiveBin()).binId as number;
  const target = planFlipRange({ activeBinId: active, lower: a.lower, upper: a.upper, tokenIsX });
  if (!target.ok) return { success: false, signatures: [], message: `Flip dibatalkan: ${target.reason}`, error: "NO_TARGET" };

  // 1) withdraw token-bearing bins only (fresh bin read)
  const before = await getTokenBalanceAtomic(tokenMint, user);
  const fresh = await pool.getPosition(posKey);
  const cls = classifyPositionBins((fresh.positionData?.positionBinData || []) as BinAmounts[], a.base.solSide);
  if (!cls.tokenRanges.length) return { success: false, signatures: [], message: "Tidak ada token untuk di-flip.", error: "NO_TOKEN" };
  for (let i = 0; i < cls.tokenRanges.length; i++) {
    const r = cls.tokenRanges[i];
    const res = await pool.removeLiquidity({ user, position: posKey, fromBinId: r.from, toBinId: r.to, bps: new BN(10_000), shouldClaimAndClose: false });
    const txs: Transaction[] = Array.isArray(res) ? res : [res];
    const items: PendingTxItem[] = [];
    for (let j = 0; j < txs.length; j++) items.push(serializeTx(await withBlockhash(txs[j], user), `flip_wd_${i + 1}_${j + 1}`));
    const out = await executePendingTxs(items);
    sigs.push(...out.signatures);
    if (!out.success) return { success: false, signatures: sigs, message: `❌ Withdraw [${r.from},${r.to}] gagal: ${out.error}`, error: out.error };
  }
  await new Promise((r) => setTimeout(r, 2000));
  const delta = (await getTokenBalanceAtomic(tokenMint, user)) - before;
  if (delta <= 0n) return { success: false, signatures: sigs, message: "⚠️ Withdraw OK tapi delta token wallet 0 — tidak ada yang di-add.", error: "ZERO_DELTA" };

  // 2) add exactly the withdrawn token back into the same position, BidAsk, token side
  const amt = new BN(delta.toString());
  const tx: Transaction = await pool.addLiquidityByStrategy({
    positionPubKey: posKey,
    user,
    totalXAmount: tokenIsX ? amt : new BN(0),
    totalYAmount: tokenIsX ? new BN(0) : amt,
    strategy: { minBinId: target.minBinId, maxBinId: target.maxBinId, strategyType: (StrategyType as Record<string, number>).BidAsk },
    slippage: meteoraSlippagePct(),
  });
  const out = await executePendingTxs([serializeTx(await withBlockhash(tx, user), "flip_add")]);
  sigs.push(...out.signatures);
  const ui = atomicToUi(delta, a.base.tokenDecimals);
  if (!out.success)
    return { success: false, signatures: sigs, message: `❌ Re-add gagal: ${out.error}. Token ${ui} masih di wallet (posisi tetap ada).`, error: out.error };
  return { success: true, signatures: sigs, message: `✅ Flip OK — ${ui} token di-add ulang BidAsk bins [${target.minBinId},${target.maxBinId}] (${target.bins} bin) ke posisi yang sama.` };
}

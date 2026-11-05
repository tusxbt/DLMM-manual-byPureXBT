/**
 * Claim fees → sell ONLY the claimed non-SOL token (exact wallet delta from the claim) to SOL via Jupiter.
 * No USD cap; uses the swap slippage setting.
 */
import { PublicKey } from "@solana/web3.js";
import { SOL_MINT, loadConfig } from "../config.js";
import { getConnection } from "./connection.js";
import { getDLMM } from "./dlmmSdk.js";
import { getMintDecimals } from "./decimals.js";
import { getWalletPublicKey } from "./wallet.js";
import { getUsdPrices } from "./prices.js";
import { buildClaimFeeTxs } from "./dlmm-build.js";
import { executePendingTxs } from "./executor.js";
import { getSwapQuote } from "./jupiter-swap.js";
import { liveSwapDeps, swapToSolRobust } from "./swap-robust.js";
import { jupiterSlippageBps } from "./slippage.js";
import { getTokenBalanceAtomic } from "./reshape.js";
import { atomicToUi, toBigIntAmount } from "./reshape-math.js";

export type ClaimSellQuote = {
  pool: string;
  position: string;
  tokenMint: string;
  tokenDecimals: number;
  feeTokenAtomic: string;
  feeTokenUi: number;
  feeSolUi: number;
  tokenUsd: number;
  estSolOut: number | null;
  quoteError?: string;
};

export async function quoteClaimSell(poolAddress: string, positionAddress: string): Promise<ClaimSellQuote> {
  const { DLMM } = await getDLMM();
  const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
  const mintX = pool.lbPair.tokenXMint.toBase58();
  const mintY = pool.lbPair.tokenYMint.toBase58();
  const tokenIsX = mintX !== SOL_MINT;
  const tokenMint = tokenIsX ? mintX : mintY;
  const pd = (await pool.getPosition(new PublicKey(positionAddress))).positionData as { feeX?: unknown; feeY?: unknown };
  const fx = toBigIntAmount((pd.feeX as { toString(): string })?.toString?.() ?? (pd.feeX as string));
  const fy = toBigIntAmount((pd.feeY as { toString(): string })?.toString?.() ?? (pd.feeY as string));
  const feeTok = tokenIsX ? fx : fy;
  const feeSol = tokenIsX ? fy : fx;
  const dec = await getMintDecimals(tokenMint);
  const feeTokenUi = atomicToUi(feeTok, dec);
  const px = (await getUsdPrices([tokenMint]))[tokenMint] ?? 0;
  const tokenUsd = feeTokenUi * px;
  let estSolOut: number | null = null;
  let quoteError: string | undefined;
  if (feeTok > 0n) {
    try {
      const q = await getSwapQuote({ inputMint: tokenMint, outputMint: SOL_MINT, amountAtomic: feeTok.toString(), slippageBps: jupiterSlippageBps() });
      estSolOut = Number(q.outAmount) / 1e9;
    } catch (e) {
      quoteError = (e as Error).message;
    }
  }
  return { pool: poolAddress, position: positionAddress, tokenMint, tokenDecimals: dec, feeTokenAtomic: feeTok.toString(), feeTokenUi, feeSolUi: atomicToUi(feeSol, 9), tokenUsd, estSolOut, quoteError };
}

export async function executeClaimSell(q: ClaimSellQuote, hooks: { onProgress?: (d: number, n: number) => Promise<void> } = {}): Promise<{ success: boolean; signatures: string[]; message: string; error?: string; leftoverMint?: string }> {
  const cfg = loadConfig({ requireTelegram: false });
  if (cfg.dryRun) return { success: true, signatures: ["DRY_RUN_claim_1", "DRY_RUN_swap_1"], message: `DRY RUN — claim lalu jual ${q.feeTokenUi} token fee → ≈${q.estSolOut ?? "?"} SOL.` };
  const user = getWalletPublicKey();
  const before = await getTokenBalanceAtomic(q.tokenMint, user);
  const claim = await executePendingTxs(await buildClaimFeeTxs({ poolAddress: q.pool, positionAddress: q.position }), [], { onProgress: hooks.onProgress });
  if (!claim.success) return { success: false, signatures: claim.signatures, message: `Claim gagal: ${claim.error}`, error: claim.error };
  await new Promise((r) => setTimeout(r, 2000));
  const delta = (await getTokenBalanceAtomic(q.tokenMint, user)) - before;
  if (delta <= 0n) return { success: true, signatures: claim.signatures, message: "Claim OK · fee token = 0, tidak ada yang dijual." };
  const ui = atomicToUi(delta, q.tokenDecimals);
  const swap = await swapToSolRobust(q.tokenMint, delta, await liveSwapDeps(), { label: "claimsell" });
  const sigs = [...claim.signatures, ...swap.signatures];
  if (!swap.success) return { success: false, signatures: sigs, message: `Claim OK · swap gagal ${swap.attempts}x: ${swap.error}. Token ${ui} tetap di wallet.`, error: swap.error, leftoverMint: q.tokenMint };
  return { success: true, signatures: sigs, message: `Claim OK · jual ${ui} token → ≈${(Number(swap.estOutLamports) / 1e9).toFixed(6)} SOL${swap.attempts > 1 ? ` (try ${swap.attempts})` : ""}` };
}

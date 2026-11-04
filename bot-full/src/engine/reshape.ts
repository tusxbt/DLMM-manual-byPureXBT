/**
 * /reshape — claim fees, withdraw token-bearing bins, re-add as new BidAsk ask-side position.
 */
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { SOL_MINT } from "../config.js";
import { log } from "../logger.js";
import { getConnection } from "./connection.js";
import { applyPriorityFee, getPriorityFeeMicroLamports } from "./priority.js";
import { getDLMM } from "./dlmmSdk.js";
import { getWallet, getWalletPublicKey } from "./wallet.js";
import { assertUsdCap, executePendingTxs } from "./executor.js";
import { getUsdPrices } from "./prices.js";
import { requireStrategy } from "../strategies/index.js";
import type { PendingTxItem } from "./pending.js";
import {
  atomicToUi,
  classifyPositionBins,
  clampReshapeWidth,
  rangeAboveActive,
  toBigIntAmount,
  type BinAmounts,
} from "./reshape-math.js";
import { loadConfig } from "../config.js";
import { meteoraSlippagePct } from "./slippage.js";
import { addTrackedPosition } from "../store/positions.js";

export type ReshapeAnalysis = {
  pool: string;
  position: string;
  poolName?: string;
  mintX: string;
  mintY: string;
  solSide: "x" | "y";
  tokenMint: string;
  tokenDecimals: number;
  solDecimals: number;
  activeBinId: number;
  tokenBins: Array<{
    binId: number;
    kind: string;
    tokenUi: number;
    solUi: number;
    tokenUsd: number;
  }>;
  tokenRanges: Array<{ from: number; to: number }>;
  bothBinCount: number;
  totalTokenUi: number;
  totalTokenUsd: number;
  totalSolInTokenBinsUi: number;
  feeTokenUi: number;
  feeSolUi: number;
  feeTokenUsd: number;
  feeSolUsd: number;
  estimatedReaddUi: number;
  estimatedReaddUsd: number;
  defaultWidth: number;
  noteBothBins: string;
};

function serializeTx(tx: Transaction, label: string): PendingTxItem {
  const serialized = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  return { serialized, encoding: "legacy", label };
}

async function withBlockhash(tx: Transaction, feePayer: PublicKey): Promise<Transaction> {
  applyPriorityFee(tx, await getPriorityFeeMicroLamports());
  const conn = getConnection();
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  return tx;
}

async function mintDecimals(mint: PublicKey): Promise<number> {
  const conn = getConnection();
  try {
    const info = await conn.getParsedAccountInfo(mint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (info.value?.data as any)?.parsed?.info?.decimals ?? (mint.toBase58() === SOL_MINT ? 9 : 6);
  } catch {
    return mint.toBase58() === SOL_MINT ? 9 : 6;
  }
}

/** SPL token balance (atomic) for owner; 0 if ATA missing. Native SOL not used for token side. */
export async function getTokenBalanceAtomic(mint: string, owner: PublicKey): Promise<bigint> {
  if (mint === SOL_MINT) {
    const lamports = await getConnection().getBalance(owner);
    return BigInt(lamports);
  }
  const conn = getConnection();
  try {
    const accounts = await conn.getParsedTokenAccountsByOwner(owner, {
      mint: new PublicKey(mint),
    });
    let total = 0n;
    for (const a of accounts.value) {
      const amt = a.account?.data?.parsed?.info?.tokenAmount?.amount;
      total += toBigIntAmount(amt);
    }
    return total;
  } catch (e) {
    log("reshape", `balance read failed: ${(e as Error).message}`, "warn");
    return 0n;
  }
}

export async function analyzeReshape(input: {
  poolAddress: string;
  positionAddress: string;
  poolName?: string;
}): Promise<ReshapeAnalysis> {
  const { DLMM } = await getDLMM();
  const conn = getConnection();
  const pool = await DLMM.create(conn, new PublicKey(input.poolAddress));
  const mintX = pool.lbPair.tokenXMint.toBase58();
  const mintY = pool.lbPair.tokenYMint.toBase58();
  const solSide: "x" | "y" = mintX === SOL_MINT ? "x" : "y";
  // If neither is SOL (exotic), treat Y as quote/SOL-like for classification fallback
  const tokenMint = solSide === "y" ? mintX : mintY;
  const tokenDecimals = await mintDecimals(new PublicKey(tokenMint));
  const solDecimals = 9;

  const active = await pool.getActiveBin();
  const activeBinId = active.binId as number;
  const positionData = await pool.getPosition(new PublicKey(input.positionAddress));
  const pd = positionData.positionData;
  const rawBins = (pd?.positionBinData || []) as BinAmounts[];

  const classified = classifyPositionBins(rawBins, solSide);
  if (!classified.tokenBins.length) {
    const err = new Error(
      "Tidak ada bin yang memegang token (non-SOL). Reshape hanya menarik bin token; posisi ini SOL-only atau kosong.",
    );
    (err as Error & { code?: string }).code = "NO_TOKEN_BINS";
    throw err;
  }

  const feeX = toBigIntAmount(pd?.feeX?.toString?.() ?? pd?.feeX);
  const feeY = toBigIntAmount(pd?.feeY?.toString?.() ?? pd?.feeY);
  const feeTokenAtomic = solSide === "y" ? feeX : feeY;
  const feeSolAtomic = solSide === "y" ? feeY : feeX;

  const prices = await getUsdPrices([tokenMint, SOL_MINT]);
  const tokenPx = prices[tokenMint] ?? 0;
  const solPx = prices[SOL_MINT] ?? 0;

  const tokenBins = classified.tokenBins.map((b) => {
    const tokenUi = atomicToUi(b.tokenAtomic, tokenDecimals);
    const solUi = atomicToUi(b.solAtomic, solDecimals);
    return {
      binId: b.binId,
      kind: b.kind,
      tokenUi,
      solUi,
      tokenUsd: tokenUi * tokenPx,
    };
  });

  const totalTokenUi = atomicToUi(classified.totalTokenAtomic, tokenDecimals);
  const feeTokenUi = atomicToUi(feeTokenAtomic, tokenDecimals);
  const feeSolUi = atomicToUi(feeSolAtomic, solDecimals);
  const estimatedReaddUi = totalTokenUi + feeTokenUi;
  const defaultWidth = clampReshapeWidth(classified.tokenBins.length, classified.tokenBins.length);

  return {
    pool: input.poolAddress,
    position: input.positionAddress,
    poolName: input.poolName,
    mintX,
    mintY,
    solSide,
    tokenMint,
    tokenDecimals,
    solDecimals,
    activeBinId,
    tokenBins,
    tokenRanges: classified.tokenRanges,
    bothBinCount: classified.bothCount,
    totalTokenUi,
    totalTokenUsd: totalTokenUi * tokenPx,
    totalSolInTokenBinsUi: atomicToUi(classified.totalSolInTokenBinsAtomic, solDecimals),
    feeTokenUi,
    feeSolUi,
    feeTokenUsd: feeTokenUi * tokenPx,
    feeSolUsd: feeSolUi * solPx,
    estimatedReaddUi,
    estimatedReaddUsd: estimatedReaddUi * tokenPx,
    defaultWidth,
    noteBothBins:
      classified.bothCount > 0
        ? `Ada ${classified.bothCount} bin campuran (token+SOL): ikut di-withdraw; bagian SOL kembali ke wallet.`
        : "Tidak ada bin campuran.",
  };
}

export type ReshapeExecResult = {
  success: boolean;
  dryRun?: boolean;
  signatures: string[];
  message: string;
  error?: string;
  newPosition?: string;
  steps: Array<{ step: string; ok: boolean; detail: string; signatures?: string[] }>;
};

function strategyTypeValue(StrategyType: Record<string, number>, key: string): number {
  if (StrategyType[key] != null) return StrategyType[key];
  throw new Error(`StrategyType.${key} tidak tersedia di SDK`);
}

/**
 * Sequential reshape. Uses wallet token balance deltas (not estimates) for re-add amount.
 */
export async function executeReshape(input: {
  poolAddress: string;
  positionAddress: string;
  poolName?: string;
  strategyId?: string;
  width?: number;
  /** Precomputed analysis for dry-run estimates / messaging */
  analysis?: ReshapeAnalysis;
}): Promise<ReshapeExecResult> {
  const cfg = loadConfig({ requireTelegram: false });
  const steps: ReshapeExecResult["steps"] = [];
  const allSigs: string[] = [];
  const user = getWalletPublicKey();
  const strategy = requireStrategy(input.strategyId || "bid_ask");

  let analysis = input.analysis;
  try {
    if (!analysis) {
      analysis = await analyzeReshape({
        poolAddress: input.poolAddress,
        positionAddress: input.positionAddress,
        poolName: input.poolName,
      });
    }
  } catch (e) {
    return {
      success: false,
      signatures: [],
      message: (e as Error).message,
      error: (e as Error).message,
      steps,
    };
  }

  const width = clampReshapeWidth(input.width ?? analysis.defaultWidth, analysis.defaultWidth);
  assertUsdCap("position", analysis.estimatedReaddUsd);

  if (cfg.dryRun) {
    const range = rangeAboveActive(analysis.activeBinId, width);
    const simSigs = [
      analysis.feeTokenUi > 0 || analysis.feeSolUi > 0 ? "DRY_RUN_claim_1" : null,
      ...analysis.tokenRanges.map((_, i) => `DRY_RUN_withdraw_${i + 1}`),
      "DRY_RUN_readd_1",
    ].filter(Boolean) as string[];
    if (analysis.feeTokenUi <= 0 && analysis.feeSolUi <= 0) {
      steps.push({ step: "claim", ok: true, detail: "Skip claim — fee ≈ 0" });
    } else {
      steps.push({
        step: "claim",
        ok: true,
        detail: `DRY_RUN claim fee token≈${analysis.feeTokenUi} SOL≈${analysis.feeSolUi}`,
        signatures: ["DRY_RUN_claim_1"],
      });
    }
    steps.push({
      step: "withdraw",
      ok: true,
      detail: `DRY_RUN withdraw ${analysis.tokenRanges.length} range(s) token≈${analysis.totalTokenUi}`,
      signatures: analysis.tokenRanges.map((_, i) => `DRY_RUN_withdraw_${i + 1}`),
    });
    steps.push({
      step: "readd",
      ok: true,
      detail: `DRY_RUN re-add ${analysis.estimatedReaddUi} token (${strategy.id}) bins [${range.minBinId},${range.maxBinId}]`,
      signatures: ["DRY_RUN_readd_1"],
    });
    return {
      success: true,
      dryRun: true,
      signatures: simSigs,
      message: [
        "DRY RUN reshape — tidak ada tx dikirim.",
        ...steps.map((s) => `• ${s.step}: ${s.detail}`),
        analysis.noteBothBins,
      ].join("\n"),
      steps,
    };
  }

  const { DLMM, StrategyType } = await getDLMM();
  const conn = getConnection();
  const pool = await DLMM.create(conn, new PublicKey(input.poolAddress));
  const positionPubKey = new PublicKey(input.positionAddress);
  const tokenMint = analysis.tokenMint;

  // ── 1) Snapshot + claim ──────────────────────────────────────
  const balBefore = await getTokenBalanceAtomic(tokenMint, user);
  let claimSigs: string[] = [];
  try {
    const positionData = await pool.getPosition(positionPubKey);
    const claimTxs: Transaction[] = await pool.claimSwapFee({
      owner: user,
      position: positionData,
    });
    if (!claimTxs?.length) {
      steps.push({ step: "claim", ok: true, detail: "Skip claim — tidak ada fee tx" });
    } else {
      const items: PendingTxItem[] = [];
      for (let i = 0; i < claimTxs.length; i++) {
        const tx = await withBlockhash(claimTxs[i], user);
        items.push(serializeTx(tx, `reshape_claim_${i + 1}`));
      }
      const r = await executePendingTxs(items);
      claimSigs = r.signatures;
      allSigs.push(...r.signatures);
      if (!r.success) {
        steps.push({
          step: "claim",
          ok: false,
          detail: r.error || "claim gagal",
          signatures: r.signatures,
        });
        return {
          success: false,
          signatures: allSigs,
          message: formatPartial("claim gagal", steps),
          error: r.error,
          steps,
        };
      }
      steps.push({
        step: "claim",
        ok: true,
        detail: `Claim OK (${r.signatures.length} tx)`,
        signatures: r.signatures,
      });
    }
  } catch (e) {
    const msg = (e as Error).message;
    // Treat empty-fee errors as skip
    if (/no fees|empty|tidak ada fee/i.test(msg)) {
      steps.push({ step: "claim", ok: true, detail: `Skip claim — ${msg}` });
    } else {
      steps.push({ step: "claim", ok: false, detail: msg });
      return {
        success: false,
        signatures: allSigs,
        message: formatPartial("claim gagal", steps),
        error: msg,
        steps,
      };
    }
  }

  const balAfterClaim = await getTokenBalanceAtomic(tokenMint, user);
  const feeDelta = balAfterClaim - balBefore;
  if (feeDelta <= 0n) {
    steps.push({
      step: "claim_delta",
      ok: true,
      detail: "Fee token delta ≈ 0 (SOL fee tetap di wallet, tidak ikut re-add)",
    });
  } else {
    steps.push({
      step: "claim_delta",
      ok: true,
      detail: `Fee token atomic +${feeDelta.toString()}`,
    });
  }

  // ── 2) Withdraw token-bearing ranges ─────────────────────────
  let withdrawSigs: string[] = [];
  try {
    // Refresh bins after claim
    const positionData = await pool.getPosition(positionPubKey);
    const rawBins = (positionData.positionData?.positionBinData || []) as BinAmounts[];
    const classified = classifyPositionBins(rawBins, analysis.solSide);
    if (!classified.tokenRanges.length) {
      steps.push({
        step: "withdraw",
        ok: false,
        detail: "Setelah claim, tidak ada bin token tersisa untuk withdraw",
      });
      return {
        success: false,
        signatures: allSigs,
        message: formatPartial("withdraw dibatalkan — tidak ada bin token", steps),
        error: "NO_TOKEN_BINS_AFTER_CLAIM",
        steps,
      };
    }

    for (let i = 0; i < classified.tokenRanges.length; i++) {
      const range = classified.tokenRanges[i];
      const removeResult = await pool.removeLiquidity({
        user,
        position: positionPubKey,
        fromBinId: range.from,
        toBinId: range.to,
        bps: new BN(10_000),
        shouldClaimAndClose: false,
      });
      const removeTxs: Transaction[] = Array.isArray(removeResult) ? removeResult : [removeResult];
      const items: PendingTxItem[] = [];
      for (let j = 0; j < removeTxs.length; j++) {
        const tx = await withBlockhash(removeTxs[j], user);
        items.push(serializeTx(tx, `reshape_wd_${i + 1}_${j + 1}`));
      }
      const r = await executePendingTxs(items);
      withdrawSigs.push(...r.signatures);
      allSigs.push(...r.signatures);
      if (!r.success) {
        steps.push({
          step: "withdraw",
          ok: false,
          detail: `Gagal range [${range.from},${range.to}]: ${r.error}`,
          signatures: r.signatures,
        });
        return {
          success: false,
          signatures: allSigs,
          message: formatPartial("withdraw parsial/gagal — claim mungkin sudah sukses", steps),
          error: r.error,
          steps,
        };
      }
      steps.push({
        step: "withdraw",
        ok: true,
        detail: `Withdraw range [${range.from},${range.to}] OK`,
        signatures: r.signatures,
      });
    }

    // Close only if position became empty
    try {
      const after = await pool.getPosition(positionPubKey);
      const bins = (after.positionData?.positionBinData || []) as BinAmounts[];
      const still = classifyPositionBins(bins, analysis.solSide);
      const anyLiq = still.classified.some((b) => b.tokenAtomic > 0n || b.solAtomic > 0n);
      if (!anyLiq) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const closeTx = await (pool as any).closePositionIfEmpty({
          owner: user,
          position: { publicKey: positionPubKey },
        });
        if (closeTx && typeof closeTx.serialize === "function") {
          const tx = await withBlockhash(closeTx as Transaction, user);
          const r = await executePendingTxs([serializeTx(tx, "reshape_close_empty")]);
          allSigs.push(...r.signatures);
          steps.push({
            step: "close_empty",
            ok: r.success,
            detail: r.success ? "Posisi kosong — ditutup" : `Close gagal: ${r.error}`,
            signatures: r.signatures,
          });
        }
      }
    } catch (e) {
      log("reshape", `close-if-empty skip: ${(e as Error).message}`, "warn");
    }
  } catch (e) {
    const msg = (e as Error).message;
    steps.push({ step: "withdraw", ok: false, detail: msg });
    return {
      success: false,
      signatures: allSigs,
      message: formatPartial("withdraw gagal — claim mungkin sudah sukses", steps),
      error: msg,
      steps,
    };
  }

  // Brief wait for RPC balance catch-up
  await new Promise((r) => setTimeout(r, 2000));
  const balAfterWd = await getTokenBalanceAtomic(tokenMint, user);
  const totalDelta = balAfterWd - balBefore;
  if (totalDelta <= 0n) {
    steps.push({
      step: "readd",
      ok: false,
      detail: "Delta token wallet ≤ 0 setelah claim+withdraw — tidak ada yang di-re-add",
    });
    return {
      success: false,
      signatures: allSigs,
      message: formatPartial("re-add dibatalkan — delta token 0", steps),
      error: "ZERO_TOKEN_DELTA",
      steps,
    };
  }

  const readdUi = atomicToUi(totalDelta, analysis.tokenDecimals);
  const prices = await getUsdPrices([tokenMint]);
  const readdUsd = readdUi * (prices[tokenMint] ?? 0);
  try {
    assertUsdCap("position", readdUsd);
  } catch (e) {
    steps.push({ step: "readd", ok: false, detail: (e as Error).message });
    return {
      success: false,
      signatures: allSigs,
      message: formatPartial(
        `Cap menolak re-add; token sudah di wallet (+${totalDelta.toString()} atomic). Claim/withdraw sudah jalan.`,
        steps,
      ),
      error: (e as Error).message,
      steps,
    };
  }

  // ── 3) Re-add as new position (token-only, above active) ──────
  try {
    const active = await pool.getActiveBin();
    const activeBinId = active.binId as number;
    const range = rangeAboveActive(activeBinId, width);
    const positionKp = Keypair.generate();
    const st = strategyTypeValue(StrategyType, strategy.meteoraKey);

    const amountX = analysis.solSide === "y" ? new BN(totalDelta.toString()) : new BN(0);
    const amountY = analysis.solSide === "y" ? new BN(0) : new BN(totalDelta.toString());

    const tx: Transaction = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKp.publicKey,
      user,
      totalXAmount: amountX,
      totalYAmount: amountY,
      strategy: {
        minBinId: range.minBinId,
        maxBinId: range.maxBinId,
        strategyType: st,
      },
      slippage: meteoraSlippagePct(),
    });
    await withBlockhash(tx, user);
    tx.partialSign(positionKp);
    const item = serializeTx(tx, "reshape_readd");
    // Must sign with wallet; position already partialSigned inside serialized blob
    void getWallet; // ensure key module loaded
    const r = await executePendingTxs([item]);
    allSigs.push(...r.signatures);
    if (!r.success) {
      steps.push({
        step: "readd",
        ok: false,
        detail: `Re-add gagal: ${r.error}. Token (+${totalDelta.toString()} atomic) masih di wallet.`,
        signatures: r.signatures,
      });
      return {
        success: false,
        signatures: allSigs,
        message: formatPartial("re-add gagal setelah claim+withdraw sukses", steps),
        error: r.error,
        steps,
      };
    }

    const newPos = positionKp.publicKey.toBase58();
    addTrackedPosition({
      position: newPos,
      pool: input.poolAddress,
      pool_name: input.poolName || analysis.poolName,
      strategy: strategy.id,
      amount_sol: 0,
      min_bin: range.minBinId,
      max_bin: range.maxBinId,
      opened_at: new Date().toISOString(),
      cost_usd: readdUsd,
    });
    steps.push({
      step: "readd",
      ok: true,
      detail: `Re-add OK pos=${newPos.slice(0, 8)}… ui≈${readdUi} usd≈${readdUsd.toFixed(2)} bins[${range.minBinId},${range.maxBinId}]`,
      signatures: r.signatures,
    });

    return {
      success: true,
      signatures: allSigs,
      newPosition: newPos,
      message: [
        "Reshape selesai.",
        ...steps.map((s) => `• ${s.step}: ${s.detail}`),
        `New position: ${newPos}`,
        claimSigs.length ? `Claim sigs: ${claimSigs.length}` : null,
        withdrawSigs.length ? `Withdraw sigs: ${withdrawSigs.length}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      steps,
    };
  } catch (e) {
    const msg = (e as Error).message;
    steps.push({ step: "readd", ok: false, detail: msg });
    return {
      success: false,
      signatures: allSigs,
      message: formatPartial("re-add gagal setelah claim+withdraw", steps),
      error: msg,
      steps,
    };
  }
}

function formatPartial(headline: string, steps: ReshapeExecResult["steps"]): string {
  return [headline, ...steps.map((s) => `${s.ok ? "✅" : "❌"} ${s.step}: ${s.detail}`)].join("\n");
}

export function formatReshapePreview(a: ReshapeAnalysis, width: number, strategyId: string): string {
  const lines: string[] = [
    `Reshape ${a.poolName || a.pool.slice(0, 8)}`,
    `Pos: ${a.position.slice(0, 4)}…${a.position.slice(-4)} | active bin ${a.activeBinId}`,
    `Token mint: ${a.tokenMint.slice(0, 4)}…${a.tokenMint.slice(-4)} (decimals ${a.tokenDecimals})`,
    "",
    "Bin token:",
  ];
  const show = a.tokenBins.slice(0, 12);
  for (const b of show) {
    lines.push(
      `• #${b.binId} [${b.kind}] token ${b.tokenUi.toPrecision(6)} ($${b.tokenUsd.toFixed(2)})` +
        (b.solUi > 0 ? ` + SOL ${b.solUi.toPrecision(4)}` : ""),
    );
  }
  if (a.tokenBins.length > show.length) lines.push(`… +${a.tokenBins.length - show.length} bin lagi`);
  lines.push(
    `Ranges withdraw: ${a.tokenRanges.map((r) => `[${r.from},${r.to}]`).join(" ")}`,
    a.noteBothBins,
    "",
    `Fee unclaimed: token ${a.feeTokenUi} ($${a.feeTokenUsd.toFixed(2)}) | SOL ${a.feeSolUi} ($${a.feeSolUsd.toFixed(2)})`,
    `Est. re-add: ${a.estimatedReaddUi} token ≈ $${a.estimatedReaddUsd.toFixed(2)}`,
    `Strategi: ${strategyId} | width ${width} bin di atas active`,
    "SOL fee tetap di wallet (tidak di-re-add).",
  );
  return lines.join("\n");
}

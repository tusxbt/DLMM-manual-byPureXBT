/**
 * /zapout — claim fees, remove 100% + close, swap all non-SOL token delta → SOL via Jupiter.
 * Exempt from hard MAX_SWAP_USD block (exit path); warns if estimated swap USD > cap.
 */
import { PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { loadConfig, SOL_MINT } from "../config.js";
import { getConnection } from "./connection.js";
import { getDLMM } from "./dlmmSdk.js";
import { getWalletPublicKey } from "./wallet.js";
import { executePendingTxs } from "./executor.js";
import { getUsdPrices } from "./prices.js";
import { getSwapQuote, buildSwapTx } from "./jupiter-swap.js";
import { getSwapSlippagePct, jupiterSlippageBps } from "./slippage.js";
import { getTokenBalanceAtomic } from "./reshape.js";
import { atomicToUi, toBigIntAmount } from "./reshape-math.js";
import { removeTrackedPosition } from "../store/positions.js";
import type { PendingTxItem } from "./pending.js";

export type ZapoutAnalysis = {
  pool: string;
  position: string;
  poolName?: string;
  mintX: string;
  mintY: string;
  solSide: "x" | "y";
  tokenMint: string;
  tokenDecimals: number;
  totalValueUsd: number;
  unclaimedFeesUsd: number;
  feeTokenUi: number;
  feeSolUi: number;
  estTokenOutUi: number;
  estTokenOutUsd: number;
  swapSlippagePct: number;
  overSwapCap: boolean;
  maxSwapUsd: number;
  warnOverCap: string | null;
};

function serializeTx(tx: Transaction, label: string): PendingTxItem {
  return {
    serialized: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    encoding: "legacy",
    label,
  };
}

async function withBlockhash(tx: Transaction, feePayer: PublicKey): Promise<Transaction> {
  const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  return tx;
}

async function mintDecimals(mint: PublicKey): Promise<number> {
  try {
    const info = await getConnection().getParsedAccountInfo(mint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (info.value?.data as any)?.parsed?.info?.decimals ?? (mint.toBase58() === SOL_MINT ? 9 : 6);
  } catch {
    return mint.toBase58() === SOL_MINT ? 9 : 6;
  }
}

export async function analyzeZapout(input: {
  poolAddress: string;
  positionAddress: string;
  poolName?: string;
  totalValueUsd?: number;
  unclaimedFeesUsd?: number;
}): Promise<ZapoutAnalysis> {
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const { DLMM } = await getDLMM();
  const conn = getConnection();
  const pool = await DLMM.create(conn, new PublicKey(input.poolAddress));
  const mintX = pool.lbPair.tokenXMint.toBase58();
  const mintY = pool.lbPair.tokenYMint.toBase58();
  const solSide: "x" | "y" = mintX === SOL_MINT ? "x" : "y";
  const tokenMint = solSide === "y" ? mintX : mintY;
  const tokenDecimals = await mintDecimals(new PublicKey(tokenMint));

  const positionData = await pool.getPosition(new PublicKey(input.positionAddress));
  const pd = positionData.positionData;
  const feeX = toBigIntAmount(pd?.feeX?.toString?.() ?? pd?.feeX);
  const feeY = toBigIntAmount(pd?.feeY?.toString?.() ?? pd?.feeY);
  const feeTokenAtomic = solSide === "y" ? feeX : feeY;
  const feeSolAtomic = solSide === "y" ? feeY : feeX;

  const totalX = toBigIntAmount(pd?.totalXAmount?.toString?.() ?? pd?.totalXAmount);
  const totalY = toBigIntAmount(pd?.totalYAmount?.toString?.() ?? pd?.totalYAmount);
  const tokenLiqAtomic = solSide === "y" ? totalX : totalY;
  const estTokenOutAtomic = tokenLiqAtomic + feeTokenAtomic;

  const prices = await getUsdPrices([tokenMint, SOL_MINT]);
  const tokenPx = prices[tokenMint] ?? 0;
  const feeTokenUi = atomicToUi(feeTokenAtomic, tokenDecimals);
  const feeSolUi = atomicToUi(feeSolAtomic, 9);
  const estTokenOutUi = atomicToUi(estTokenOutAtomic, tokenDecimals);
  const estTokenOutUsd = estTokenOutUi * tokenPx;
  const overSwapCap = estTokenOutUsd > cfg.maxSwapUsd;
  const swapSlippagePct = getSwapSlippagePct();

  return {
    pool: input.poolAddress,
    position: input.positionAddress,
    poolName: input.poolName,
    mintX,
    mintY,
    solSide,
    tokenMint,
    tokenDecimals,
    totalValueUsd: Number(input.totalValueUsd ?? 0),
    unclaimedFeesUsd: Number(input.unclaimedFeesUsd ?? 0),
    feeTokenUi,
    feeSolUi,
    estTokenOutUi,
    estTokenOutUsd,
    swapSlippagePct,
    overSwapCap,
    maxSwapUsd: cfg.maxSwapUsd,
    warnOverCap: overSwapCap
      ? `⚠️ Est. swap ${estTokenOutUsd.toFixed(2)} USD > MAX_SWAP_USD=${cfg.maxSwapUsd}. Zapout tetap diizinkan (exit path), tapi lanjutkan hati-hati.`
      : null,
  };
}

export type ZapoutExecResult = {
  success: boolean;
  dryRun?: boolean;
  signatures: string[];
  message: string;
  error?: string;
  steps: Array<{ step: string; ok: boolean; detail: string; signatures?: string[] }>;
};

export async function executeZapout(input: {
  poolAddress: string;
  positionAddress: string;
  poolName?: string;
  analysis?: ZapoutAnalysis;
}): Promise<ZapoutExecResult> {
  const cfg = loadConfig({ requireTelegram: false });
  const steps: ZapoutExecResult["steps"] = [];
  const allSigs: string[] = [];
  const user = getWalletPublicKey();

  let analysis = input.analysis;
  try {
    if (!analysis) {
      analysis = await analyzeZapout({
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

  if (cfg.dryRun) {
    const slip = analysis.swapSlippagePct;
    steps.push({
      step: "claim",
      ok: true,
      detail:
        analysis.feeTokenUi > 0 || analysis.feeSolUi > 0
          ? `DRY_RUN claim fee token≈${analysis.feeTokenUi} SOL≈${analysis.feeSolUi}`
          : "Skip claim — fee ≈ 0",
      signatures: analysis.feeTokenUi > 0 || analysis.feeSolUi > 0 ? ["DRY_RUN_claim_1"] : undefined,
    });
    steps.push({
      step: "remove_close",
      ok: true,
      detail: "DRY_RUN remove 100% + close",
      signatures: ["DRY_RUN_close_1"],
    });
    steps.push({
      step: "swap",
      ok: true,
      detail: `DRY_RUN swap ≈${analysis.estTokenOutUi} token → SOL (slip ${slip}%, est $${analysis.estTokenOutUsd.toFixed(2)})`,
      signatures: ["DRY_RUN_swap_1"],
    });
    const sigs = steps.flatMap((s) => s.signatures || []);
    return {
      success: true,
      dryRun: true,
      signatures: sigs,
      message: [
        "DRY RUN zapout — tidak ada tx dikirim.",
        ...steps.map((s) => `• ${s.step}: ${s.detail}`),
        analysis.warnOverCap,
      ]
        .filter(Boolean)
        .join("\n"),
      steps,
    };
  }

  const { DLMM } = await getDLMM();
  const conn = getConnection();
  const pool = await DLMM.create(conn, new PublicKey(input.poolAddress));
  const positionPubKey = new PublicKey(input.positionAddress);
  const tokenMint = analysis.tokenMint;

  const balBefore = await getTokenBalanceAtomic(tokenMint, user);

  // ── 1) Claim ─────────────────────────────────────────────────
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
        items.push(serializeTx(await withBlockhash(claimTxs[i], user), `zapout_claim_${i + 1}`));
      }
      const r = await executePendingTxs(items);
      allSigs.push(...r.signatures);
      if (!r.success) {
        steps.push({ step: "claim", ok: false, detail: r.error || "claim gagal", signatures: r.signatures });
        return partial("claim gagal", steps, allSigs, r.error);
      }
      steps.push({ step: "claim", ok: true, detail: `Claim OK (${r.signatures.length} tx)`, signatures: r.signatures });
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (/no fees|empty|tidak ada fee/i.test(msg)) {
      steps.push({ step: "claim", ok: true, detail: `Skip claim — ${msg}` });
    } else {
      steps.push({ step: "claim", ok: false, detail: msg });
      return partial("claim gagal", steps, allSigs, msg);
    }
  }

  // ── 2) Remove 100% + close ───────────────────────────────────
  try {
    const positionData = await pool.getPosition(positionPubKey);
    const binIds = (positionData.positionData?.positionBinData || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (b: any) => b.binId as number,
    );
    const fromBin = binIds.length
      ? Math.min(...binIds)
      : positionData.positionData?.lowerBinId ?? -887272;
    const toBin = binIds.length
      ? Math.max(...binIds)
      : positionData.positionData?.upperBinId ?? 887272;

    const removeResult = await pool.removeLiquidity({
      user,
      position: positionPubKey,
      fromBinId: fromBin,
      toBinId: toBin,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });
    const removeTxs: Transaction[] = Array.isArray(removeResult) ? removeResult : [removeResult];
    const items: PendingTxItem[] = [];
    for (let i = 0; i < removeTxs.length; i++) {
      items.push(serializeTx(await withBlockhash(removeTxs[i], user), `zapout_close_${i + 1}`));
    }
    const r = await executePendingTxs(items);
    allSigs.push(...r.signatures);
    if (!r.success) {
      steps.push({
        step: "remove_close",
        ok: false,
        detail: r.error || "remove/close gagal",
        signatures: r.signatures,
      });
      return partial("remove/close gagal — claim mungkin sudah sukses", steps, allSigs, r.error);
    }
    steps.push({
      step: "remove_close",
      ok: true,
      detail: `Remove+close OK (${r.signatures.length} tx)`,
      signatures: r.signatures,
    });
    removeTrackedPosition(input.positionAddress);
  } catch (e) {
    const msg = (e as Error).message;
    steps.push({ step: "remove_close", ok: false, detail: msg });
    return partial("remove/close gagal", steps, allSigs, msg);
  }

  await new Promise((r) => setTimeout(r, 2000));
  const balAfter = await getTokenBalanceAtomic(tokenMint, user);
  const delta = balAfter - balBefore;

  if (delta <= 0n) {
    steps.push({
      step: "swap",
      ok: true,
      detail: "Tidak ada token non-SOL untuk di-swap (delta ≤ 0). SOL sudah di wallet.",
    });
    return {
      success: true,
      signatures: allSigs,
      message: ["Zapout selesai (tanpa swap token).", ...steps.map((s) => `• ${s.step}: ${s.detail}`)].join("\n"),
      steps,
    };
  }

  // ── 3) Swap all token delta → SOL ────────────────────────────
  try {
    const quote = await getSwapQuote({
      inputMint: tokenMint,
      outputMint: SOL_MINT,
      amountAtomic: delta.toString(),
      slippageBps: jupiterSlippageBps(),
    });
    const tx = await buildSwapTx({ quote });
    const r = await executePendingTxs([tx]);
    allSigs.push(...r.signatures);
    if (!r.success) {
      steps.push({
        step: "swap",
        ok: false,
        detail: `Swap gagal: ${r.error}. Token (+${delta.toString()} atomic) masih di wallet.`,
        signatures: r.signatures,
      });
      return partial("swap gagal setelah close sukses — token masih di wallet", steps, allSigs, r.error);
    }
    const outUi = Number(quote.outAmount) / 1e9;
    steps.push({
      step: "swap",
      ok: true,
      detail: `Swap OK in=${delta.toString()} → est SOL ${outUi} (slip ${getSwapSlippagePct()}%)`,
      signatures: r.signatures,
    });
    return {
      success: true,
      signatures: allSigs,
      message: ["Zapout selesai.", ...steps.map((s) => `• ${s.step}: ${s.detail}`)].join("\n"),
      steps,
    };
  } catch (e) {
    const msg = (e as Error).message;
    steps.push({ step: "swap", ok: false, detail: msg });
    return partial("swap gagal — token masih di wallet", steps, allSigs, msg);
  }
}

function partial(
  headline: string,
  steps: ZapoutExecResult["steps"],
  sigs: string[],
  error?: string,
): ZapoutExecResult {
  return {
    success: false,
    signatures: sigs,
    message: [headline, ...steps.map((s) => `${s.ok ? "✅" : "❌"} ${s.step}: ${s.detail}`)].join("\n"),
    error,
    steps,
  };
}

export function formatZapoutPreview(a: ZapoutAnalysis): string {
  const lines = [
    `Zapout ${a.poolName || a.pool.slice(0, 8)}`,
    `Pos: ${a.position.slice(0, 4)}…${a.position.slice(-4)}`,
    `Nilai pos ≈ $${a.totalValueUsd.toFixed(2)} | fees ≈ $${a.unclaimedFeesUsd.toFixed(2)}`,
    `Token: ${a.tokenMint.slice(0, 4)}…${a.tokenMint.slice(-4)}`,
    `Est. token keluar (liq+fee): ${a.estTokenOutUi} ≈ $${a.estTokenOutUsd.toFixed(2)}`,
    `Fee: token ${a.feeTokenUi} | SOL ${a.feeSolUi} (SOL fee tetap di wallet)`,
    `Slippage swap: ${a.swapSlippagePct}% (${jupiterSlippageBps(a.swapSlippagePct)} bps Jupiter)`,
    "Langkah: claim → remove 100%+close → swap SEMUA token non-SOL → SOL",
  ];
  if (a.warnOverCap) lines.push(a.warnOverCap);
  return lines.join("\n");
}


import { getMintDecimals } from "./decimals.js";
/**
 * /zapout — claim fees, remove 100% + close, swap all non-SOL token delta → SOL via Jupiter.
 */
import { PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { loadConfig, SOL_MINT } from "../config.js";
import { getConnection } from "./connection.js";
import { applyPriorityFee, getPriorityFeeMicroLamports } from "./priority.js";
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
  applyPriorityFee(tx, await getPriorityFeeMicroLamports());
  const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  return tx;
}

async function mintDecimals(mint: PublicKey): Promise<number> {
  return getMintDecimals(mint);
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
    warnOverCap: null,
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
  onStage?: (stage: "close" | "swap") => void | Promise<void>;
  onProgress?: (done: number, total: number, label: string) => void | Promise<void>;
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

  const t0 = Date.now();
  const timing: Array<[string, number]> = [];
  const lap = (name: string, from: number) => timing.push([name, Date.now() - from]);
  const { DLMM } = await getDLMM();
  const conn = getConnection();
  const positionPubKey = new PublicKey(input.positionAddress);
  const swapMints = nonSolMints(analysis.mintX, analysis.mintY);

  // pool load + pre-balances in parallel
  let tPrep = Date.now();
  const [pool, ...balBefore] = await Promise.all([
    DLMM.create(conn, new PublicKey(input.poolAddress)),
    ...swapMints.map((m) => getTokenBalanceAtomic(m, user)),
  ]);
  lap("prep", tPrep);

  // ── 1) Remove 100% + claim + close in as few txs as SDK allows ──
  const tClose = Date.now();
  try {
    const positionData = await pool.getPosition(positionPubKey);
    const binIds = (positionData.positionData?.positionBinData || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (b: any) => b.binId as number,
    );
    const fromBin = binIds.length ? Math.min(...binIds) : positionData.positionData?.lowerBinId ?? -887272;
    const toBin = binIds.length ? Math.max(...binIds) : positionData.positionData?.upperBinId ?? 887272;
    const removeResult = await pool.removeLiquidity({
      user,
      position: positionPubKey,
      fromBinId: fromBin,
      toBinId: toBin,
      bps: new BN(10_000),
      shouldClaimAndClose: true, // claims fees + rewards and closes in the same tx(s)
    });
    const removeTxs: Transaction[] = Array.isArray(removeResult) ? removeResult : [removeResult];
    const items: PendingTxItem[] = [];
    for (let i = 0; i < removeTxs.length; i++) {
      items.push(serializeTx(await withBlockhash(removeTxs[i], user), `zapout_close_${i + 1}`));
    }
    const r = await executePendingTxs(items, [], { onProgress: input.onProgress }); // confirms at "confirmed"
    allSigs.push(...r.signatures);
    if (!r.success) {
      steps.push({ step: "claim_remove_close", ok: false, detail: r.error || "remove/close gagal", signatures: r.signatures });
      return partial("remove/close gagal", steps, allSigs, r.error, timing);
    }
    lap("claim+remove+close", tClose);
    steps.push({
      step: "claim_remove_close",
      ok: true,
      detail: `Claim+remove+close OK (${r.signatures.length} tx)`,
      signatures: r.signatures,
    });
    removeTrackedPosition(input.positionAddress);
  } catch (e) {
    const msg = (e as Error).message;
    steps.push({ step: "claim_remove_close", ok: false, detail: msg });
    return partial("remove/close gagal", steps, allSigs, msg, timing);
  }

  // ── 2) Balance deltas (confirmed) → parallel quotes → swaps ──
  try {
    await input.onStage?.("swap");
  } catch {
    /* UI only */
  }
  const tQuote = Date.now();
  const balAfter = await Promise.all(swapMints.map((m) => getTokenBalanceAtomic(m, user)));
  const deltas = swapMints.map((m, i) => ({ mint: m, delta: balAfter[i] - (balBefore[i] as bigint) }));
  const todo = deltas.filter((d) => d.delta > 0n);
  if (!todo.length) {
    steps.push({ step: "swap", ok: true, detail: "Tidak ada token non-SOL untuk di-swap (delta ≤ 0)." });
    lap("total", t0);
    return done("Zapout selesai (tanpa swap).", steps, allSigs, timing);
  }
  const built = await Promise.allSettled(
    todo.map(async (d) => {
      const quote = await getSwapQuote({
        inputMint: d.mint,
        outputMint: SOL_MINT,
        amountAtomic: d.delta.toString(),
        slippageBps: jupiterSlippageBps(),
      });
      return { d, quote, tx: await buildSwapTx({ quote }) };
    }),
  );
  lap("quote+build", tQuote);
  const tSwap = Date.now();
  const sent = await Promise.allSettled(
    built.map(async (b, i) => {
      if (b.status === "rejected") throw new Error(`quote ${todo[i].mint.slice(0, 4)}…: ${(b.reason as Error).message}`);
      const r = await executePendingTxs([b.value.tx]);
      if (!r.success) throw new Error(`swap ${todo[i].mint.slice(0, 4)}…: ${r.error}`);
      return { r, quote: b.value.quote, d: b.value.d };
    }),
  );
  lap("swap", tSwap);
  let allOk = true;
  for (const x of sent) {
    if (x.status === "fulfilled") {
      allSigs.push(...x.value.r.signatures);
      steps.push({
        step: "swap",
        ok: true,
        detail: `${x.value.d.mint.slice(0, 4)}… in=${x.value.d.delta} → est ${(Number(x.value.quote.outAmount) / 1e9).toFixed(6)} SOL`,
        signatures: x.value.r.signatures,
      });
    } else {
      allOk = false;
      steps.push({ step: "swap", ok: false, detail: `${(x.reason as Error).message} — token masih di wallet` });
    }
  }
  lap("total", t0);
  if (!allOk) return partial("Swap sebagian gagal — posisi sudah tertutup, token sisa di wallet", steps, allSigs, "swap gagal", timing);
  return done("Zapout selesai.", steps, allSigs, timing);
}

export function nonSolMints(mintX: string, mintY: string): string[] {
  return [mintX, mintY].filter((m, i, a) => m && m !== SOL_MINT && a.indexOf(m) === i);
}

export function formatTiming(timing: Array<[string, number]>): string {
  if (!timing.length) return "";
  return "⏱ " + timing.map(([k, ms]) => `${k} ${(ms / 1000).toFixed(1)}s`).join(" · ");
}

function done(
  headline: string,
  steps: ZapoutExecResult["steps"],
  sigs: string[],
  timing: Array<[string, number]>,
): ZapoutExecResult {
  return {
    success: true,
    signatures: sigs,
    message: [headline, ...steps.map((s) => `• ${s.step}: ${s.detail}`), formatTiming(timing)].filter(Boolean).join("\n"),
    steps,
  };
}

function partial(
  headline: string,
  steps: ZapoutExecResult["steps"],
  sigs: string[],
  error?: string,
  timing: Array<[string, number]> = [],
): ZapoutExecResult {
  return {
    success: false,
    signatures: sigs,
    message: [headline, ...steps.map((s) => `${s.ok ? "✅" : "❌"} ${s.step}: ${s.detail}`), formatTiming(timing)]
      .filter(Boolean)
      .join("\n"),
    error,
    steps,
  };
}

export function formatZapoutPreview(a: ZapoutAnalysis): string {
  const lines = [
    `Zapout ${a.poolName || a.pool.slice(0, 8)}`,
    `Pos: ${a.position.slice(0, 4)}…${a.position.slice(-4)}`,
    `Nilai pos ≈ ${Number.isFinite(a.totalValueUsd) ? `$${a.totalValueUsd.toFixed(2)}` : "n/a"} | fees ≈ ${Number.isFinite(a.unclaimedFeesUsd) ? `$${a.unclaimedFeesUsd.toFixed(2)}` : "n/a"}`,
    `Token: ${a.tokenMint.slice(0, 4)}…${a.tokenMint.slice(-4)}`,
    `Est. token keluar (liq+fee): ${a.estTokenOutUi} ≈ $${a.estTokenOutUsd.toFixed(2)}`,
    `Fee: token ${a.feeTokenUi} | SOL ${a.feeSolUi} (SOL fee tetap di wallet)`,
    `Slippage swap: ${a.swapSlippagePct}% (${jupiterSlippageBps(a.swapSlippagePct)} bps Jupiter)`,
    "Langkah (cepat): claim+remove 100%+close (1 alur, priority fee) → swap paralel SEMUA token non-SOL → SOL",
  ];
  if (a.warnOverCap) lines.push(a.warnOverCap);
  return lines.join("\n");
}


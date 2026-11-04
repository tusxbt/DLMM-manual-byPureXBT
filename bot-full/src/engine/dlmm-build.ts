import { getMintDecimals } from "./decimals.js";
/**
 * Build DLMM transactions. Ephemeral position keypair partialSigns; wallet signs at execute time.
 */
import {
  ComputeBudgetProgram,
  TransactionInstruction,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { getConnection } from "./connection.js";
import { getWalletPublicKey } from "./wallet.js";
import { getDLMM } from "./dlmmSdk.js";
import type { PendingTxItem } from "./pending.js";
import type { StrategyDefinition, StrategySide, ResolvedRange } from "../strategies/types.js";
import { log } from "../logger.js";
import { meteoraSlippagePct } from "./slippage.js";
import { applyPriorityFee, getPriorityFeeMicroLamports } from "./priority.js";

function serializeTx(tx: Transaction): PendingTxItem {
  // Ensure recent blockhash + feePayer set by caller
  const serialized = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  return { serialized, encoding: "legacy", label: "tx" };
}

async function withBlockhash(tx: Transaction, feePayer: PublicKey): Promise<Transaction> {
  applyPriorityFee(tx, await getPriorityFeeMicroLamports());
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  void lastValidBlockHeight;
  return tx;
}

function strategyTypeValue(StrategyType: Record<string, number>, key: string): number {
  if (StrategyType[key] != null) return StrategyType[key];
  // some builds use nested
  throw new Error(`StrategyType.${key} tidak tersedia di SDK`);
}

/** Single-tx path (initializePositionAndAddLiquidityByStrategy) up to this many bins. */
export const SINGLE_TX_MAX_BINS = 69;
/** Meteora POSITION_MAX_LENGTH. */
export const WIDE_MAX_BINS = 1400;
const MAX_TX_BYTES = 1232;

export type WideQuote = {
  /** refundable on close (SOL) */
  positionRentSol: number;
  /** non-refundable: new bin arrays + bitmap extension (SOL) */
  binArrayRentSol: number;
  binArraysCount: number;
  txCount: number;
};

export type BuildAddResult = {
  quote?: WideQuote;
  /** rent quote for any path (single-tx too): position rent (refundable) + new bin arrays (not refundable) */
  rent?: Omit<WideQuote, "txCount">;
  mix?: { pct: number; primaryText: string; spotText: string };
  txs: PendingTxItem[];
  position: string;
  minBin: number;
  maxBin: number;
  activeBin: number;
  meta: Record<string, unknown>;
};

export async function buildAddLiquidityTxs(input: {
  poolAddress: string;
  strategy: StrategyDefinition;
  side: StrategySide;
  amountSol: number;
  amountTokenUi?: number;
  range: ResolvedRange;
  poolName?: string;
  /** Mix strategy: % BidAsk (rest Spot). */
  mixPct?: number;
}): Promise<BuildAddResult> {
  const user = getWalletPublicKey();
  const { DLMM, StrategyType } = await getDLMM();
  const conn = getConnection();
  const pool = await DLMM.create(conn, new PublicKey(input.poolAddress));
  const active = await pool.getActiveBin();
  const activeBinId = active.binId as number;

  const binsBelow = Math.max(0, Math.floor(input.range.binsBelow));
  const binsAbove = Math.max(0, Math.floor(input.range.binsAbove));
  if (binsBelow + binsAbove < 1) {
    throw new Error("Range terlalu sempit (minimal 1 bin).");
  }
  if (binsBelow + binsAbove + 1 > WIDE_MAX_BINS) {
    throw new Error(`Range ${binsBelow + binsAbove + 1} bins > ${WIDE_MAX_BINS} (batas 1 posisi Meteora).`);
  }

  const minBinId = activeBinId - binsBelow;
  const maxBinId = activeBinId + binsAbove;
  const positionKp = Keypair.generate();

  const amountY = new BN(Math.floor(input.amountSol * 1e9));
  let amountX = new BN(0);
  if (input.side === "two_sided" && input.amountTokenUi && input.amountTokenUi > 0) {
    const mintX = pool.lbPair.tokenXMint;
    const dec = await getMintDecimals(mintX, (pool as { tokenX?: unknown }).tokenX);
    amountX = new BN(Math.floor(input.amountTokenUi * 10 ** dec));
  }

  const st = strategyTypeValue(StrategyType, input.strategy.meteoraKey);
  // Mix: primary (BidAsk) gets mixPct of the amount; the rest goes in as Spot to the same position/range
  const isMix = input.strategy.id === "mix";
  const mixPct = isMix ? (input.mixPct ?? 70) : 100;
  const split = splitMixAmounts(amountX, amountY, mixPct);
  const totalX = amountX;
  const totalY = amountY;
  amountX = split.primaryX;
  const amountYPrimary = split.primaryY;
  const finish = async (r0: BuildAddResult): Promise<BuildAddResult> => {
    const r = r0;
    if (!r.rent) {
      r.rent = r.quote
        ? { positionRentSol: r.quote.positionRentSol, binArrayRentSol: r.quote.binArrayRentSol, binArraysCount: r.quote.binArraysCount }
        : await quoteWide(pool, { minBinId, maxBinId, strategyType: st });
    }
    if (!isMix) return r;
    const spotTxs = (
      await buildWideAddTxs(pool, positionKp.publicKey, user, split.spotX, split.spotY, {
        minBinId,
        maxBinId,
        strategyType: strategyTypeValue(StrategyType, "Spot"),
      })
    ).map((t, i) => ({ ...t, label: `mixSpot_${i + 1}` }));
    r.txs.push(...spotTxs);
    if (r.quote) r.quote.txCount = r.txs.length;
    r.mix = { pct: mixPct, primaryText: fmtAmt(split.primaryX, split.primaryY), spotText: fmtAmt(split.spotX, split.spotY) };
    Object.assign(r.meta, {
      mix_pct: mixPct,
      strategy_label: `Mix ${mixPct}/${100 - mixPct}`,
      mix_spot_x_atomic: split.spotX.toString(),
      mix_spot_y_atomic: split.spotY.toString(),
      mix_spot_tx_count: spotTxs.length,
      amount_x_atomic: split.primaryX.toString(),
      amount_y_atomic: split.primaryY.toString(),
      total_x_atomic: totalX.toString(),
      total_y_atomic: totalY.toString(),
      strategy_key: input.strategy.meteoraKey,
    });
    return r;
  };
  log(
    "build_add",
    `pool=${input.poolAddress.slice(0, 8)} strat=${input.strategy.id} bins=[${minBinId},${maxBinId}] sol=${input.amountSol}`,
  );

  if (maxBinId - minBinId + 1 > SINGLE_TX_MAX_BINS + 1) {
    const strategyParams = { minBinId, maxBinId, strategyType: st };
    const txs = await buildWideTxs(pool, positionKp, user, amountX, amountYPrimary, strategyParams);
    const quote = await quoteWide(pool, strategyParams);
    return finish({
      txs,
      position: positionKp.publicKey.toBase58(),
      minBin: minBinId,
      maxBin: maxBinId,
      activeBin: activeBinId,
      quote: { ...quote, txCount: txs.length },
      meta: {
        pool: input.poolAddress,
        pool_name: input.poolName || null,
        strategy: input.strategy.id,
        side: input.side,
        amount_sol: input.amountSol,
        amount_token: input.amountTokenUi ?? 0,
        min_bin: minBinId,
        max_bin: maxBinId,
        active_bin: activeBinId,
        position: positionKp.publicKey.toBase58(),
        wide: true,
        strategy_key: input.strategy.meteoraKey,
        amount_x_atomic: amountX.toString(),
        amount_y_atomic: amountYPrimary.toString(),
        create_tx_count: txs.filter((t) => t.label.startsWith("createPos")).length,
        add_tx_count: txs.filter((t) => t.label.startsWith("addChunk")).length,
      },
    });
  }

  const tx: Transaction = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKp.publicKey,
    user,
    totalXAmount: amountX,
    totalYAmount: amountYPrimary,
    strategy: { minBinId, maxBinId, strategyType: st },
    slippage: meteoraSlippagePct(),
  });

  await withBlockhash(tx, user);
  // Ephemeral position co-signer ONLY — never user wallet
  tx.partialSign(positionKp);

  const item = serializeTx(tx);
  item.label = "initializePositionAndAddLiquidity";
  item.coSigners = [positionKp]; // memory-only: lets executor re-sign after fresh blockhash

  // positionKp secret kept in memory only (confirm store, ≤60s) for re-sign; never persisted
  return finish({
    txs: [item],
    position: positionKp.publicKey.toBase58(),
    minBin: minBinId,
    maxBin: maxBinId,
    activeBin: activeBinId,
    meta: {
      pool: input.poolAddress,
      pool_name: input.poolName || null,
      strategy: input.strategy.id,
      side: input.side,
      amount_sol: input.amountSol,
      amount_token: input.amountTokenUi ?? 0,
      min_bin: minBinId,
      max_bin: maxBinId,
      active_bin: activeBinId,
      position: positionKp.publicKey.toBase58(),
    },
  });
}

export async function buildClaimFeeTxs(input: {
  poolAddress: string;
  positionAddress: string;
}): Promise<PendingTxItem[]> {
  const user = getWalletPublicKey();
  const { DLMM } = await getDLMM();
  const conn = getConnection();
  const pool = await DLMM.create(conn, new PublicKey(input.poolAddress));
  const positionData = await pool.getPosition(new PublicKey(input.positionAddress));
  const txs: Transaction[] = await pool.claimSwapFee({
    owner: user,
    position: positionData,
  });
  if (!txs?.length) throw new Error("Tidak ada fee untuk di-claim (tx kosong).");
  const out: PendingTxItem[] = [];
  for (let i = 0; i < txs.length; i++) {
    const tx = await withBlockhash(txs[i], user);
    const item = serializeTx(tx);
    item.label = `claimFee_${i + 1}`;
    out.push(item);
  }
  return out;
}

export async function buildRemoveAndCloseTxs(input: {
  poolAddress: string;
  positionAddress: string;
}): Promise<PendingTxItem[]> {
  const user = getWalletPublicKey();
  const { DLMM } = await getDLMM();
  const conn = getConnection();
  const pool = await DLMM.create(conn, new PublicKey(input.poolAddress));
  const positionPubKey = new PublicKey(input.positionAddress);
  const out: PendingTxItem[] = [];

  // Optional claim first
  try {
    const positionData = await pool.getPosition(positionPubKey);
    const claimTxs: Transaction[] = await pool.claimSwapFee({
      owner: user,
      position: positionData,
    });
    for (let i = 0; i < (claimTxs || []).length; i++) {
      const tx = await withBlockhash(claimTxs[i], user);
      const item = serializeTx(tx);
      item.label = `claim_before_remove_${i + 1}`;
      out.push(item);
    }
  } catch (e) {
    log("build_remove", `claim skip: ${(e as Error).message}`, "warn");
  }

  const positionData = await pool.getPosition(positionPubKey);
  const binIds = (positionData.positionData?.positionBinData || []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b: any) => b.binId as number,
  );
  const fromBin = binIds.length ? Math.min(...binIds) : positionData.positionData?.lowerBinId;
  const toBin = binIds.length ? Math.max(...binIds) : positionData.positionData?.upperBinId;

  const removeResult = await pool.removeLiquidity({
    user,
    position: positionPubKey,
    fromBinId: fromBin,
    toBinId: toBin,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });

  const removeTxs: Transaction[] = Array.isArray(removeResult) ? removeResult : [removeResult];
  for (let i = 0; i < removeTxs.length; i++) {
    const tx = await withBlockhash(removeTxs[i], user);
    const item = serializeTx(tx);
    item.label = `removeClose_${i + 1}`;
    out.push(item);
  }
  return out;
}

/** Estimate bins from pct using bin step (approx). */
export function binsFromPct(activePrice: number, pct: number, binStep: number, direction: "down" | "up"): number {
  if (pct <= 0 || !activePrice || !binStep) return 0;
  // binStep is in basis points of price per bin roughly: price ratio per bin ≈ (1 + binStep/10000)
  const step = binStep / 10_000;
  if (step <= 0) return 0;
  const target =
    direction === "down" ? activePrice * (1 - pct / 100) : activePrice * (1 + pct / 100);
  let bins = 0;
  let p = activePrice;
  if (direction === "down") {
    while (p > target && bins < 500) {
      p = p / (1 + step);
      bins++;
    }
  } else {
    while (p < target && bins < 500) {
      p = p * (1 + step);
      bins++;
    }
  }
  return bins;
}

export function isVersionedTxBase64(b64: string): boolean {
  try {
    const buf = Buffer.from(b64, "base64");
    VersionedTransaction.deserialize(buf);
    return true;
  } catch {
    return false;
  }
}


// ── wide (>69 bins) positions ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPool = any;

function txFits(ixs: TransactionInstruction[], payer: PublicKey, signers: number): boolean {
  try {
    const t = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }).add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ...ixs,
    );
    const msgLen = t.serializeMessage().length;
    return msgLen + 1 + signers * 64 <= MAX_TX_BYTES;
  } catch {
    return false;
  }
}

/** Greedy-pack instructions into as few txs as fit (≤1232 bytes). First group keeps `first` ixs together. */
export function packInstructions(ixs: TransactionInstruction[], payer: PublicKey, firstSigners = 2): TransactionInstruction[][] {
  const groups: TransactionInstruction[][] = [];
  let cur: TransactionInstruction[] = [];
  for (const ix of ixs) {
    const signers = groups.length === 0 ? firstSigners : 1;
    if (cur.length && !txFits([...cur, ix], payer, signers)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(ix);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

async function buildWideTxs(
  pool: AnyPool,
  positionKp: Keypair,
  user: PublicKey,
  amountX: BN,
  amountY: BN,
  strategy: { minBinId: number; maxBinId: number; strategyType: number },
): Promise<PendingTxItem[]> {
  const { minBinId, maxBinId } = strategy;
  // 1) init (70 bins) + increasePositionLength(Upper) ixs — built locally, no on-chain fetch
  const all: TransactionInstruction[] = await pool.createInitAndExtendPositionIx(
    minBinId,
    maxBinId,
    Math.min(maxBinId - minBinId + 1, 70),
    user,
    positionKp.publicKey,
  );
  const ixs = all.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  const groups = packInstructions(ixs, user, 2);
  const out: PendingTxItem[] = [];
  for (let i = 0; i < groups.length; i++) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...groups[i]);
    await withBlockhash(tx, user);
    const needsPos = i === 0;
    if (needsPos) tx.partialSign(positionKp);
    const item = serializeTx(tx);
    item.label = `createPos_${i + 1}`;
    if (needsPos) item.coSigners = [positionKp];
    out.push(item);
  }
  // 2) chunked add liquidity (≤70 bins per tx, rebalance endpoint) — SDK computes distribution
  out.push(...(await buildWideAddTxs(pool, positionKp.publicKey, user, amountX, amountY, strategy)));
  return out;
}

export async function buildWideAddTxs(
  pool: AnyPool,
  position: PublicKey,
  user: PublicKey,
  amountX: BN,
  amountY: BN,
  strategy: { minBinId: number; maxBinId: number; strategyType: number },
): Promise<PendingTxItem[]> {
  const addTxs: Transaction[] = await pool.addLiquidityByStrategyChunkable({
    positionPubKey: position,
    user,
    totalXAmount: amountX,
    totalYAmount: amountY,
    strategy,
    slippage: meteoraSlippagePct(),
  });
  const out: PendingTxItem[] = [];
  for (let i = 0; i < addTxs.length; i++) {
    const tx = await withBlockhash(addTxs[i], user);
    const item = serializeTx(tx);
    item.label = `addChunk_${i + 1}`;
    out.push(item);
  }
  return out;
}

async function quoteWide(pool: AnyPool, strategy: { minBinId: number; maxBinId: number; strategyType: number }): Promise<Omit<WideQuote, "txCount">> {
  try {
    const q = await pool.quoteCreatePosition({ strategy });
    return {
      positionRentSol: Number(q.positionCost) + Number(q.positionReallocCost),
      binArrayRentSol: Number(q.binArrayCost) + Number(q.bitmapExtensionCost),
      binArraysCount: Number(q.binArraysCount),
    };
  } catch (e) {
    log("build_add", `quote failed: ${(e as Error).message}`, "warn");
    return { positionRentSol: NaN, binArrayRentSol: NaN, binArraysCount: NaN };
  }
}

/**
 * Resume a partially deployed wide position: extend to target width if needed, then add the
 * remaining liquidity chunks (skips the first `addDone` chunk txs of a fresh chunk plan).
 */
export async function buildWideResumeTxs(input: {
  poolAddress: string;
  positionAddress: string;
  minBin: number;
  maxBin: number;
  strategyKey: string;
  amountXAtomic: string;
  amountYAtomic: string;
  addDone: number;
  /** false for single-tx Mix deploys (primary already complete) */
  wide?: boolean;
  addTotal?: number;
  mix?: { done: number; total: number; spotX: string; spotY: string };
}): Promise<PendingTxItem[]> {
  const user = getWalletPublicKey();
  const { DLMM, StrategyType } = await getDLMM();
  const conn = getConnection();
  const pool = await DLMM.create(conn, new PublicKey(input.poolAddress));
  const position = new PublicKey(input.positionAddress);
  const out: PendingTxItem[] = [];
  const range = { minBinId: input.minBin, maxBinId: input.maxBin };
  if (input.wide !== false) {
    const pos = await pool.getPosition(position);
    const upper = Number(pos.positionData?.upperBinId);
    if (Number.isFinite(upper) && upper < input.maxBin) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const grouped: TransactionInstruction[][] = await (pool as any).increasePositionLengthIxs(position, 1, new BN(input.maxBin - upper), user, user, false, false);
      for (const [i, g] of packInstructions(grouped.flat(), user, 1).entries()) {
        const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...g);
        await withBlockhash(tx, user);
        const item = serializeTx(tx);
        item.label = `createPos_extend_${i + 1}`;
        out.push(item);
      }
    }
    if (input.addTotal == null || input.addDone < input.addTotal) {
      const st = strategyTypeValue(StrategyType, input.strategyKey);
      const adds = await buildWideAddTxs(pool, position, user, new BN(input.amountXAtomic), new BN(input.amountYAtomic), { ...range, strategyType: st });
      out.push(...adds.slice(Math.max(0, input.addDone)));
    }
  }
  if (input.mix && input.mix.done < input.mix.total) {
    const spot = await buildWideAddTxs(pool, position, user, new BN(input.mix.spotX), new BN(input.mix.spotY), {
      ...range,
      strategyType: strategyTypeValue(StrategyType, "Spot"),
    });
    out.push(...spot.slice(Math.max(0, input.mix.done)).map((t, i) => ({ ...t, label: `mixSpot_r${i + 1}` })));
  }
  return out;
}

/** Split atomic amounts for Mix (primary = floor(pct%), spot = remainder → no dust lost). */
export function splitMixAmounts(x: BN, y: BN, pct: number): { primaryX: BN; primaryY: BN; spotX: BN; spotY: BN } {
  const p = Math.max(1, Math.min(100, Math.round(pct)));
  const primaryX = x.muln(p).divn(100);
  const primaryY = y.muln(p).divn(100);
  return { primaryX, primaryY, spotX: x.sub(primaryX), spotY: y.sub(primaryY) };
}

function fmtAmt(x: BN, y: BN): string {
  const parts: string[] = [];
  if (!y.isZero()) parts.push(`${(Number(y.toString()) / 1e9).toFixed(4)} SOL`);
  if (!x.isZero()) parts.push(`${x.toString()} token(atomic)`);
  return parts.join(" + ") || "0";
}

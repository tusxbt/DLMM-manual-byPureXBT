/**
 * Build DLMM transactions. Ephemeral position keypair partialSigns; wallet signs at execute time.
 */
import {
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

export type BuildAddResult = {
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
  if (binsBelow + binsAbove > 69) {
    throw new Error(
      "Range >69 bins belum didukung di bot-safe v1 (butuh multi-tx extended). Pilih range lebih sempit.",
    );
  }

  const minBinId = activeBinId - binsBelow;
  const maxBinId = activeBinId + binsAbove;
  const positionKp = Keypair.generate();

  const amountY = new BN(Math.floor(input.amountSol * 1e9));
  let amountX = new BN(0);
  if (input.side === "two_sided" && input.amountTokenUi && input.amountTokenUi > 0) {
    // assume 6 decimals fallback — refined via mint decimals when possible
    let dec = 6;
    try {
      const mintX = pool.lbPair.tokenXMint;
      const info = await conn.getParsedAccountInfo(mintX);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dec = (info.value?.data as any)?.parsed?.info?.decimals ?? 6;
    } catch {
      /* keep 6 */
    }
    amountX = new BN(Math.floor(input.amountTokenUi * 10 ** dec));
  }

  const st = strategyTypeValue(StrategyType, input.strategy.meteoraKey);
  log(
    "build_add",
    `pool=${input.poolAddress.slice(0, 8)} strat=${input.strategy.id} bins=[${minBinId},${maxBinId}] sol=${input.amountSol}`,
  );

  const tx: Transaction = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKp.publicKey,
    user,
    totalXAmount: amountX,
    totalYAmount: amountY,
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
  return {
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
  };
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

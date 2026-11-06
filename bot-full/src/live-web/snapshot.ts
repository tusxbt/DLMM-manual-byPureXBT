import { PublicKey } from "@solana/web3.js";
import { fmtMoney, currentDisplayCurrency, type DisplayCurrency } from "../display-money.js";
import { getActiveBin, listLivePositions, type LivePosition } from "../engine/dlmm-read.js";
import { getConnection } from "../engine/connection.js";
import { getDLMM } from "../engine/dlmmSdk.js";
import { toBigIntAmount, type BinAmounts } from "../engine/reshape-math.js";
import { getTrackedPosition } from "../store/positions.js";
import { strategyLabel } from "../format.js";
import { runAsUser } from "../users/context.js";
import type { LiveBinBar, LiveSnapshot } from "./types.js";

function short(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** Flat Spot-style bars across [min,max]; active highlighted by client. */
export function barsFromRange(minBin: number, maxBin: number): LiveBinBar[] {
  const lo = Math.min(minBin, maxBin);
  const hi = Math.max(minBin, maxBin);
  const n = Math.max(1, hi - lo + 1);
  const step = n > 61 ? Math.ceil(n / 61) : 1;
  const out: LiveBinBar[] = [];
  for (let id = lo; id <= hi; id += step) {
    out.push({ binId: id, height: 0.72 });
  }
  if (out[out.length - 1]?.binId !== hi) out.push({ binId: hi, height: 0.72 });
  return out;
}

/**
 * Real heights from SDK positionBinData (X+Y atomic liquidity), normalized 0–1.
 * Fills empty bins in [min,max] with height 0; downsamples when range > 61.
 */
export function barsFromBinData(
  raw: Array<{ binId: number; positionXAmount?: string | number; positionYAmount?: string | number }>,
  minBin: number,
  maxBin: number,
): LiveBinBar[] {
  const lo = Math.min(minBin, maxBin);
  const hi = Math.max(minBin, maxBin);
  const liq = new Map<number, bigint>();
  let maxLiq = 0n;
  for (const b of raw) {
    if (b.binId < lo || b.binId > hi) continue;
    const v = toBigIntAmount(b.positionXAmount) + toBigIntAmount(b.positionYAmount);
    liq.set(b.binId, v);
    if (v > maxLiq) maxLiq = v;
  }
  const n = Math.max(1, hi - lo + 1);
  const step = n > 61 ? Math.ceil(n / 61) : 1;
  const out: LiveBinBar[] = [];
  for (let id = lo; id <= hi; id += step) {
    // when downsampling, take max liquidity in the bucket
    let bucket = 0n;
    for (let j = id; j < id + step && j <= hi; j++) {
      const v = liq.get(j) ?? 0n;
      if (v > bucket) bucket = v;
    }
    const height = maxLiq === 0n ? 0 : Number((bucket * 10_000n) / maxLiq) / 10_000;
    out.push({ binId: id, height });
  }
  if (out.length && out[out.length - 1].binId !== hi) {
    const v = liq.get(hi) ?? 0n;
    out.push({ binId: hi, height: maxLiq === 0n ? 0 : Number((v * 10_000n) / maxLiq) / 10_000 });
  }
  return out;
}

export function snapshotFromLivePosition(
  p: LivePosition,
  opts: {
    currency?: DisplayCurrency;
    demo?: boolean;
    pair?: string;
    strategy?: string;
    bins?: LiveBinBar[];
  } = {},
): LiveSnapshot {
  const currency = (opts.currency ?? currentDisplayCurrency()) as LiveSnapshot["currency"];
  const minBin = p.min_bin ?? p.active_id ?? 0;
  const maxBin = p.max_bin ?? p.active_id ?? 0;
  const active = p.active_id ?? minBin;
  const money = (usd: number | null | undefined, sign = false) =>
    fmtMoney(usd, { currency, sign, na: "—" });
  const tracked = getTrackedPosition(p.position);
  const pair = opts.pair || p.pair || tracked?.pool_name?.replace(/-/g, "/") || "TOKEN/SOL";
  const strategy =
    opts.strategy ||
    tracked?.strategy_label ||
    (tracked?.strategy ? strategyLabel(tracked.strategy) : undefined) ||
    "—";

  return {
    demo: !!opts.demo,
    ts: new Date().toISOString(),
    pair,
    strategy,
    positionShort: short(p.position),
    poolShort: short(p.pool),
    activeBinId: active,
    activePrice: p.active_price ?? 0,
    minBinId: minBin,
    maxBinId: maxBin,
    minPrice: p.min_price ?? 0,
    maxPrice: p.max_price ?? 0,
    inRange: p.in_range !== false,
    bins: opts.bins ?? barsFromRange(minBin, maxBin),
    pnlUsd: p.pnl_usd,
    feesUsd: p.unclaimed_fees_usd,
    capitalUsd: p.pnl_usd != null && p.total_value_usd != null ? p.total_value_usd - p.pnl_usd : null,
    valueUsd: p.total_value_usd,
    currency,
    pnlText: money(p.pnl_usd, true),
    feesText: money(p.unclaimed_fees_usd, false),
    valueText: money(p.total_value_usd, false),
    capitalText: money(
      p.pnl_usd != null && p.total_value_usd != null ? p.total_value_usd - p.pnl_usd : null,
      false,
    ),
  };
}

async function loadPositionBinBars(
  pool: string,
  position: string,
  minBin: number,
  maxBin: number,
): Promise<{ bars: LiveBinBar[]; activeId?: number; activePrice?: number; minPrice?: number; maxPrice?: number } | null> {
  try {
    const { DLMM } = await getDLMM();
    const dlmm = await DLMM.create(getConnection(), new PublicKey(pool));
    const pos = await dlmm.getPosition(new PublicKey(position));
    const pd = pos.positionData as {
      lowerBinId?: number;
      upperBinId?: number;
      positionBinData?: BinAmounts[];
    };
    const lo = pd.lowerBinId ?? minBin;
    const hi = pd.upperBinId ?? maxBin;
    const bars = barsFromBinData(pd.positionBinData || [], lo, hi);
    let activeId: number | undefined;
    let activePrice: number | undefined;
    try {
      const ab = await dlmm.getActiveBin();
      activeId = ab.binId as number;
      activePrice = Number(ab.price);
    } catch {
      /* */
    }
    return { bars, activeId, activePrice };
  } catch {
    return null;
  }
}

export type LiveFetchArgs = {
  position: string;
  pool: string;
  currency: LiveSnapshot["currency"];
  pair?: string;
  strategy?: string;
  ownerUserId?: string;
  isOwner?: boolean;
  ownerWallet?: string;
};

/** Hub fetcher: real bins + economics. Only returns data if position still on the owner's wallet. */
export async function fetchLiveSnapshot(args: LiveFetchArgs): Promise<LiveSnapshot | null> {
  const work = async (): Promise<LiveSnapshot | null> => {
    const tracked = getTrackedPosition(args.position);
    const cost: Record<string, number> = {};
    if (tracked?.cost_usd) cost[tracked.position] = tracked.cost_usd;

    const positions = await listLivePositions(cost);
    const p = positions.find((x) => x.position === args.position);
    if (!p) return null; // closed or not this wallet's

    // optional wallet sanity (session minted for a specific pubkey)
    // listLivePositions already scoped to current wallet via runAsUser

    try {
      const ab = await getActiveBin(args.pool || p.pool);
      p.active_id = ab.binId;
      p.active_price = ab.price;
      if (p.min_bin != null && p.max_bin != null) {
        p.in_range = ab.binId >= p.min_bin && ab.binId <= p.max_bin;
      }
    } catch {
      /* keep last */
    }

    const minBin = p.min_bin ?? p.active_id ?? 0;
    const maxBin = p.max_bin ?? p.active_id ?? 0;
    const binPack = await loadPositionBinBars(args.pool || p.pool, args.position, minBin, maxBin);
    if (binPack?.activeId != null) {
      p.active_id = binPack.activeId;
      if (binPack.activePrice != null && Number.isFinite(binPack.activePrice)) p.active_price = binPack.activePrice;
      if (p.min_bin != null && p.max_bin != null) {
        p.in_range = binPack.activeId >= p.min_bin && binPack.activeId <= p.max_bin;
      }
    }

    const pair =
      args.pair ||
      p.pair ||
      tracked?.pool_name?.replace(/-/g, "/") ||
      undefined;
    const strategy =
      args.strategy ||
      tracked?.strategy_label ||
      (tracked?.strategy ? strategyLabel(tracked.strategy) : undefined);

    return snapshotFromLivePosition(p, {
      currency: args.currency,
      pair,
      strategy,
      bins: binPack?.bars,
    });
  };

  if (args.ownerUserId) {
    return await runAsUser({ userId: args.ownerUserId, isOwner: !!args.isOwner }, () => work());
  }
  return work();
}


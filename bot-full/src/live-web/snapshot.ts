import { PublicKey } from "@solana/web3.js";
import { fmtMoney, currentDisplayCurrency, type DisplayCurrency } from "../display-money.js";
import { binIdToUiPrice, type LivePosition } from "../engine/dlmm-read.js";
import { getConnection } from "../engine/connection.js";
import { getDLMM } from "../engine/dlmmSdk.js";
import { getMintDecimals } from "../engine/decimals.js";
import { getUsdPrices } from "../engine/prices.js";
import { toBigIntAmount, type BinAmounts } from "../engine/reshape-math.js";
import { getTrackedPosition } from "../store/positions.js";
import { strategyLabel } from "../format.js";
import { runAsUser } from "../users/context.js";
import { SOL_MINT } from "../config.js";
import { log } from "../logger.js";
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
    capitalUsd?: number | null;
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
  const capitalUsd =
    opts.capitalUsd !== undefined
      ? opts.capitalUsd
      : tracked?.cost_usd ??
        (p.pnl_usd != null && p.total_value_usd != null ? p.total_value_usd - p.pnl_usd : null);

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
    capitalUsd,
    valueUsd: p.total_value_usd,
    currency,
    pnlText: money(p.pnl_usd, true),
    feesText: money(p.unclaimed_fees_usd, false),
    valueText: money(p.total_value_usd, false),
    capitalText: money(capitalUsd, false),
  };
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

type CacheEntry = { at: number; snap: LiveSnapshot; err?: string };
const CACHE_TTL_MS = 2_000;
const ERR_BACKOFF_MS = 5_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<LiveSnapshot | null>>();

export function resetLiveSnapshotCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

function cacheKey(args: LiveFetchArgs): string {
  return `${args.ownerWallet || args.ownerUserId || "w"}:${args.position}:${args.currency}`;
}

/** Read one position via SDK (no full wallet scan). Uses configured RPC via getConnection(). */
async function loadOnePositionSnapshot(args: LiveFetchArgs): Promise<LiveSnapshot> {
  const poolAddr = args.pool?.trim();
  const posAddr = args.position?.trim();
  if (!poolAddr || !posAddr) throw new Error("position/pool missing");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(poolAddr) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(posAddr)) {
    throw new Error("invalid position/pool address");
  }

  // Ensure connection (RPC_URL / RPC_URLS) is initialized before SDK calls
  const conn = getConnection();
  if (!conn) throw new Error("RPC connection unavailable");

  const { DLMM } = await getDLMM();
  const dlmm = await DLMM.create(conn, new PublicKey(poolAddr));
  const pos = await dlmm.getPosition(new PublicKey(posAddr));
  const pd = pos.positionData as {
    lowerBinId?: number;
    upperBinId?: number;
    positionBinData?: BinAmounts[];
    totalXAmount?: string | { toString(): string };
    totalYAmount?: string | { toString(): string };
    feeX?: string | { toString(): string };
    feeY?: string | { toString(): string };
  };

  const mintX = (dlmm as { tokenX?: { publicKey?: PublicKey } }).tokenX?.publicKey?.toBase58?.() || "";
  const mintY = (dlmm as { tokenY?: { publicKey?: PublicKey } }).tokenY?.publicKey?.toBase58?.() || "";
  const reserveX = (dlmm as { tokenX?: unknown }).tokenX;
  const reserveY = (dlmm as { tokenY?: unknown }).tokenY;
  const decX = mintX ? await getMintDecimals(mintX, reserveX) : 9;
  const decY = mintY ? await getMintDecimals(mintY, reserveY) : 9;

  const totalX = Number(pd.totalXAmount?.toString?.() ?? pd.totalXAmount ?? 0) / 10 ** decX;
  const totalY = Number(pd.totalYAmount?.toString?.() ?? pd.totalYAmount ?? 0) / 10 ** decY;
  const feeX = Number(pd.feeX?.toString?.() ?? pd.feeX ?? 0) / 10 ** decX;
  const feeY = Number(pd.feeY?.toString?.() ?? pd.feeY ?? 0) / 10 ** decY;

  const lbPair = (dlmm as { lbPair?: { activeId?: number; binStep?: number } }).lbPair;
  let activeId = lbPair?.activeId;
  const binStep = lbPair?.binStep;
  let activePrice: number | null = null;
  try {
    const ab = await dlmm.getActiveBin();
    activeId = ab.binId as number;
    activePrice = Number(dlmm.fromPricePerLamport(Number(ab.price)));
  } catch {
    /* keep lbPair */
  }

  const minBin = pd.lowerBinId ?? activeId ?? 0;
  const maxBin = pd.upperBinId ?? activeId ?? 0;
  const inRange = activeId != null ? activeId >= minBin && activeId <= maxBin : true;
  const bars = barsFromBinData(pd.positionBinData || [], minBin, maxBin);

  const mints = [SOL_MINT, mintX, mintY].filter(Boolean);
  const prices = await getUsdPrices(mints);
  const px = mintX ? prices[mintX] ?? 0 : 0;
  const py = mintY ? prices[mintY] ?? 0 : 0;
  const priced = (totalX + feeX === 0 || px > 0) && (totalY + feeY === 0 || py > 0);
  const value = totalX * px + totalY * py;
  const fees = feeX * px + feeY * py;

  const tracked = getTrackedPosition(posAddr);
  const cost = tracked?.cost_usd;
  const known = priced && cost != null && cost > 0;
  const pnl = known ? value + fees - cost : null;

  const binPrice = (id?: number) =>
    id != null && binStep ? binIdToUiPrice(id, binStep, decX, decY) : null;

  const live: LivePosition = {
    position: posAddr,
    pool: poolAddr,
    pair: args.pair || tracked?.pool_name?.replace(/-/g, "/"),
    total_value_usd: priced ? Math.round(value * 100) / 100 : null,
    unclaimed_fees_usd: priced ? Math.round(fees * 100) / 100 : null,
    pnl_usd: pnl == null ? null : Math.round(pnl * 100) / 100,
    pnl_pct: known && pnl != null && cost ? Math.round((pnl / cost) * 10000) / 100 : null,
    in_range: inRange,
    active_id: activeId,
    bin_step: binStep,
    min_price: binPrice(minBin),
    max_price: binPrice(maxBin),
    active_price: activePrice ?? binPrice(activeId),
    mint_x: mintX,
    mint_y: mintY,
    min_bin: minBin,
    max_bin: maxBin,
    amount_x: totalX,
    amount_y: totalY,
  };

  return snapshotFromLivePosition(live, {
    currency: args.currency,
    pair: args.pair || live.pair,
    strategy:
      args.strategy ||
      tracked?.strategy_label ||
      (tracked?.strategy ? strategyLabel(tracked.strategy) : undefined),
    bins: bars,
    capitalUsd: cost ?? null,
  });
}

/** Hub fetcher: cached, single-position read. No full-wallet listLivePositions. */
export async function fetchLiveSnapshot(args: LiveFetchArgs): Promise<LiveSnapshot | null> {
  const key = cacheKey(args);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.snap;
  if (hit?.err && now - hit.at < ERR_BACKOFF_MS) {
    // serve last good snap during backoff if any
    return hit.snap ?? null;
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const work = async (): Promise<LiveSnapshot | null> => {
    try {
      const snap = await loadOnePositionSnapshot(args);
      cache.set(key, { at: Date.now(), snap });
      return snap;
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      log("live-web", `snapshot ${short(args.position)}: ${msg.slice(0, 120)}`, "warn");
      const prev = cache.get(key)?.snap;
      cache.set(key, {
        at: Date.now(),
        snap: prev || ({
          demo: false,
          ts: new Date().toISOString(),
          pair: args.pair || "TOKEN/SOL",
          strategy: args.strategy || "—",
          positionShort: short(args.position),
          poolShort: short(args.pool),
          activeBinId: 0,
          activePrice: 0,
          minBinId: 0,
          maxBinId: 0,
          minPrice: 0,
          maxPrice: 0,
          inRange: true,
          bins: [],
          pnlUsd: null,
          feesUsd: null,
          capitalUsd: null,
          valueUsd: null,
          currency: args.currency,
          pnlText: "—",
          feesText: "—",
          valueText: "—",
          capitalText: "—",
          error: msg.slice(0, 160),
        } as LiveSnapshot),
        err: msg,
      });
      // Prefer last good; else error-bearing stub so UI can show message (not fake green empty)
      return cache.get(key)!.snap;
    }
  };

  const run = args.ownerUserId
    ? () => runAsUser({ userId: args.ownerUserId!, isOwner: !!args.isOwner }, () => work())
    : work;

  const p = Promise.resolve()
    .then(run)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

import { getMintDecimals } from "./decimals.js";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./connection.js";
import { getDLMM } from "./dlmmSdk.js";
import { getUsdPrices } from "./prices.js";
import { SOL_MINT } from "../config.js";
import { log } from "../logger.js";
import { getWalletPublicKey } from "./wallet.js";

export type PoolHit = {
  pool: string;
  name: string;
  bin_step: number | null;
  fee_pct: number | null;
  tvl: number | null;
  volume_24h: number | null;
  /** pool LP fees (USD) last 24h, all-time; fee/TVL 24h in % */
  fees_24h?: number | null;
  fees_total?: number | null;
  fee_tvl_24h_pct?: number | null;
  token_x?: { symbol?: string; mint?: string };
  token_y?: { symbol?: string; mint?: string };
};

/** datapi returns token_x/token_y objects {address,symbol}; older shape had mint_x + mint_x_symbol. */
export function tokenInfo(obj: unknown, legacySymbol?: unknown, legacyMint?: unknown): { symbol: string; mint: string } {
  const o = (obj && typeof obj === "object" ? obj : {}) as { address?: string; symbol?: string };
  return { symbol: String(o.symbol || legacySymbol || ""), mint: String(o.address || legacyMint || "") };
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map one datapi pool object (exported for tests). */
export function mapPoolForTest(p: Record<string, unknown>): PoolHit {
  return mapPool(p);
}

export async function searchPools(query: string, limit = 8): Promise<PoolHit[]> {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search HTTP ${res.status}`);
  const data = await res.json();
  const raw = (Array.isArray(data) ? data : data.data || []) as Record<string, unknown>[];
  const mapped = raw.map(mapPool);
  mapped.sort((a, b) => {
    const tv = (b.tvl ?? 0) - (a.tvl ?? 0);
    if (tv !== 0) return tv;
    return (b.volume_24h ?? 0) - (a.volume_24h ?? 0);
  });
  return mapped.slice(0, limit);
}

function mapPool(p: Record<string, unknown>): PoolHit {
  {
    const poolConfig = (p.pool_config || {}) as Record<string, unknown>;
    const volume = (p.volume || {}) as Record<string, unknown>;
    return {
      pool: String(p.address || p.pool_address || ""),
      name: String(p.name || "pool"),
      bin_step: Number(poolConfig.bin_step ?? p.bin_step ?? null) || null,
      fee_pct: Number(poolConfig.base_fee_pct ?? p.base_fee_percentage ?? p.fee_pct ?? null) || null,
      tvl: Number(p.tvl ?? p.liquidity ?? null) || null,
      volume_24h: numOrNull(volume["24h"] ?? volume.h24 ?? p.trade_volume_24h),
      fees_24h: numOrNull(((p.fees || {}) as Record<string, unknown>)["24h"] ?? p.fees_24h),
      fees_total: numOrNull(((p.cumulative_metrics || {}) as Record<string, unknown>).fees ?? p.cumulative_fee_volume),
      fee_tvl_24h_pct: numOrNull(((p.fee_tvl_ratio || {}) as Record<string, unknown>)["24h"]),
      token_x: tokenInfo(p.token_x, (p as { mint_x_symbol?: string }).mint_x_symbol, p.mint_x),
      token_y: tokenInfo(p.token_y, (p as { mint_y_symbol?: string }).mint_y_symbol, p.mint_y),
    };
  }
}

export async function getActiveBin(poolAddress: string): Promise<{ binId: number; price: number }> {
  const { DLMM } = await getDLMM();
  const conn = getConnection();
  const pool = await DLMM.create(conn, new PublicKey(poolAddress));
  const active = await pool.getActiveBin();
  const price = pool.fromPricePerLamport(Number(active.price));
  return { binId: active.binId, price: Number(price) };
}

/** DLMM bin price in UI units (token Y per token X). */
export function binIdToUiPrice(binId: number, binStep: number, decX: number, decY: number): number {
  return Math.pow(1 + binStep / 10_000, binId) * Math.pow(10, decX - decY);
}

export type LivePosition = {
  position: string;
  pool: string;
  pair?: string;
  /** null when a needed token price is unknown (shown as n/a, never $0) */
  total_value_usd: number | null;
  unclaimed_fees_usd: number | null;
  /** null when deposit cost is unknown (never invented) */
  pnl_usd: number | null;
  pnl_pct: number | null;
  in_range: boolean | null;
  active_id?: number;
  bin_step?: number;
  /** UI prices (token Y per token X) */
  min_price?: number | null;
  max_price?: number | null;
  active_price?: number | null;
  mint_x?: string;
  mint_y?: string;
  min_bin?: number;
  max_bin?: number;
  amount_x?: number;
  amount_y?: number;
};

export async function listLivePositions(costByPosition: Record<string, number> = {}): Promise<LivePosition[]> {
  const { DLMM } = await getDLMM();
  const conn = getConnection();
  const user = getWalletPublicKey();
  // SDK: getAllLbPairPositionsByUser
  let map: Map<string, unknown>;
  try {
    map = await DLMM.getAllLbPairPositionsByUser(conn, user);
  } catch (e) {
    log("positions", `SDK list failed: ${(e as Error).message}`, "error");
    throw e;
  }

  const mints = new Set<string>([SOL_MINT]);
  type Raw = {
    pool: string;
    position: string;
    pair?: string;
    totalX: number;
    totalY: number;
    feeX: number;
    feeY: number;
    mintX: string;
    mintY: string;
    inRange: boolean | null;
    minBin?: number;
    maxBin?: number;
    activeId?: number;
    binStep?: number;
    decX: number;
    decY: number;
  };
  const raws: Raw[] = [];

  for (const [poolStr, group] of map.entries()) {
    const g = group as {
      lbPairPositionsData?: Array<{
        publicKey: PublicKey;
        positionData: {
          totalXAmount?: string | { toString(): string };
          totalYAmount?: string | { toString(): string };
          feeX?: string | { toString(): string };
          feeY?: string | { toString(): string };
          lowerBinId?: number;
          upperBinId?: number;
          positionBinData?: unknown[];
        };
      }>;
      tokenX?: { publicKey?: PublicKey; mint?: unknown };
      tokenY?: { publicKey?: PublicKey; mint?: unknown };
      lbPair?: { activeId?: number; binStep?: number };
    };
    const mintX = g.tokenX?.publicKey?.toString?.() || "";
    const mintY = g.tokenY?.publicKey?.toString?.() || "";
    if (mintX) mints.add(mintX);
    if (mintY) mints.add(mintY);
    // TokenReserve has no `.decimal` — real value is mint.decimals (fallback: on-chain mint)
    const decX = mintX ? await getMintDecimals(mintX, g.tokenX) : 9;
    const decY = mintY ? await getMintDecimals(mintY, g.tokenY) : 9;
    const activeId = g.lbPair?.activeId;
    const binStep = g.lbPair?.binStep;

    for (const pos of g.lbPairPositionsData || []) {
      const pd = pos.positionData || {};
      const totalX = Number(pd.totalXAmount?.toString?.() ?? pd.totalXAmount ?? 0) / 10 ** decX;
      const totalY = Number(pd.totalYAmount?.toString?.() ?? pd.totalYAmount ?? 0) / 10 ** decY;
      const feeX = Number(pd.feeX?.toString?.() ?? pd.feeX ?? 0) / 10 ** decX;
      const feeY = Number(pd.feeY?.toString?.() ?? pd.feeY ?? 0) / 10 ** decY;
      const minBin = pd.lowerBinId;
      const maxBin = pd.upperBinId;
      let inRange: boolean | null = null;
      if (activeId != null && minBin != null && maxBin != null) {
        inRange = activeId >= minBin && activeId <= maxBin;
      }
      raws.push({
        pool: poolStr,
        position: pos.publicKey.toBase58(),
        pair: undefined,
        totalX,
        totalY,
        feeX,
        feeY,
        mintX,
        mintY,
        inRange,
        minBin,
        maxBin,
        activeId,
        binStep,
        decX,
        decY,
      });
    }
  }

  const prices = await getUsdPrices([...mints]);
  return raws.map((r) => {
    const px = prices[r.mintX] ?? 0;
    const py = prices[r.mintY] ?? 0;
    const priced = (r.totalX + r.feeX === 0 || px > 0) && (r.totalY + r.feeY === 0 || py > 0);
    const value = r.totalX * px + r.totalY * py;
    const fees = r.feeX * px + r.feeY * py;
    const cost = costByPosition[r.position];
    const known = priced && cost != null && cost > 0 && (px > 0 || r.totalX === 0) && (py > 0 || r.totalY === 0);
    const pnl = known ? value + fees - cost : null;
    const pnlPct = known && pnl != null ? (pnl / cost) * 100 : null;
    const binPrice = (id?: number) =>
      id != null && r.binStep ? binIdToUiPrice(id, r.binStep, r.decX, r.decY) : null;
    return {
      position: r.position,
      pool: r.pool,
      total_value_usd: priced ? Math.round(value * 100) / 100 : null,
      unclaimed_fees_usd: priced ? Math.round(fees * 100) / 100 : null,
      pnl_usd: pnl == null ? null : Math.round(pnl * 100) / 100,
      pnl_pct: pnlPct == null ? null : Math.round(pnlPct * 100) / 100,
      in_range: r.inRange,
      active_id: r.activeId,
      bin_step: r.binStep,
      min_price: binPrice(r.minBin),
      max_price: binPrice(r.maxBin),
      active_price: binPrice(r.activeId),
      mint_x: r.mintX,
      mint_y: r.mintY,
      min_bin: r.minBin,
      max_bin: r.maxBin,
      amount_x: r.totalX,
      amount_y: r.totalY,
    };
  });
}

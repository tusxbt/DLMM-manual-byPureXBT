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
  token_x?: { symbol?: string; mint?: string };
  token_y?: { symbol?: string; mint?: string };
};

export async function searchPools(query: string, limit = 8): Promise<PoolHit[]> {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search HTTP ${res.status}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return pools.map((p: Record<string, unknown>) => {
    const poolConfig = (p.pool_config || {}) as Record<string, unknown>;
    const volume = (p.volume || {}) as Record<string, unknown>;
    return {
      pool: String(p.address || p.pool_address || ""),
      name: String(p.name || "pool"),
      bin_step: Number(poolConfig.bin_step ?? p.bin_step ?? null) || null,
      fee_pct: Number(poolConfig.base_fee_pct ?? p.base_fee_percentage ?? p.fee_pct ?? null) || null,
      tvl: Number(p.tvl ?? p.liquidity ?? null) || null,
      volume_24h: Number(volume.h24 ?? p.trade_volume_24h ?? null) || null,
      token_x: {
        symbol: String((p as { mint_x_symbol?: string }).mint_x_symbol || ""),
        mint: String(p.mint_x || ""),
      },
      token_y: {
        symbol: String((p as { mint_y_symbol?: string }).mint_y_symbol || ""),
        mint: String(p.mint_y || ""),
      },
    };
  });
}

export async function getActiveBin(poolAddress: string): Promise<{ binId: number; price: number }> {
  const { DLMM } = await getDLMM();
  const conn = getConnection();
  const pool = await DLMM.create(conn, new PublicKey(poolAddress));
  const active = await pool.getActiveBin();
  const price = pool.fromPricePerLamport(Number(active.price));
  return { binId: active.binId, price: Number(price) };
}

export type LivePosition = {
  position: string;
  pool: string;
  pair?: string;
  total_value_usd: number;
  unclaimed_fees_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  in_range: boolean | null;
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
      tokenX?: { publicKey?: PublicKey; mint?: PublicKey; decimal?: number };
      tokenY?: { publicKey?: PublicKey; mint?: PublicKey; decimal?: number };
      lbPair?: { activeId?: number };
    };
    const mintX = (g.tokenX?.publicKey || g.tokenX?.mint)?.toString?.() || "";
    const mintY = (g.tokenY?.publicKey || g.tokenY?.mint)?.toString?.() || "";
    if (mintX) mints.add(mintX);
    if (mintY) mints.add(mintY);
    const decX = Number(g.tokenX?.decimal ?? 9);
    const decY = Number(g.tokenY?.decimal ?? 9);
    const activeId = g.lbPair?.activeId;

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
      });
    }
  }

  const prices = await getUsdPrices([...mints]);
  return raws.map((r) => {
    const px = prices[r.mintX] ?? 0;
    const py = prices[r.mintY] ?? 0;
    const value = r.totalX * px + r.totalY * py;
    const fees = r.feeX * px + r.feeY * py;
    const cost = costByPosition[r.position] ?? value;
    const pnl = value + fees - cost;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
    return {
      position: r.position,
      pool: r.pool,
      total_value_usd: Math.round(value * 100) / 100,
      unclaimed_fees_usd: Math.round(fees * 100) / 100,
      pnl_usd: Math.round(pnl * 100) / 100,
      pnl_pct: Math.round(pnlPct * 100) / 100,
      in_range: r.inRange,
      min_bin: r.minBin,
      max_bin: r.maxBin,
      amount_x: r.totalX,
      amount_y: r.totalY,
    };
  });
}

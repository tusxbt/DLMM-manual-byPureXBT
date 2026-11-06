/**
 * Read-only DLMM pool scanner (SOL pairs). Public Meteora datapi + RPC/public mcap —
 * no wallet, no trades, no auto-scheduler.
 * Hard filters (Syra LP) then rank by fee APR / fees / vol / TVL with −5 per risk flag.
 */
import fs from "node:fs";
import path from "node:path";
import { getConnection } from "../engine/connection.js";
import { log } from "../logger.js";
import {
  connectionAsRpc,
  fetchTokenMetaMany,
  type RpcLike,
  type TokenMeta,
} from "./token-meta.js";

export const SOL = "So11111111111111111111111111111111111111112";
const API = "https://dlmm.datapi.meteora.ag/pools";

export type ScanConfig = {
  minTvl: number;
  maxTvl: number;
  minVol24h: number;
  maxBinStep: number;
  minBinStep: number;
  topN: number;
  pages: number;
  /** Risk-flag window for NEW_POOL (hours). Soft. */
  newPoolHours: number;
  /** Hard: minimum pool age (hours). */
  minPoolAgeHours: number;
  minHolders: number;
  maxTop10HolderPct: number;
  minMarketCap: number;
  excludeFreezeAuth: boolean;
  excludeMintAuth: boolean;
  /** Hard-drop unverified tokens (default false — keep them). */
  excludeUnverified: boolean;
  blacklistMints: string[];
  /** Target scan cadence in minutes (config only — not auto-started). */
  intervalMinutes: number;
};

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean) => {
  if (v == null || v.trim() === "") return d;
  return /^(1|true|yes|on)$/i.test(v.trim());
};
export function parseBlacklistMints(v: string | undefined): string[] {
  if (!v?.trim()) return [];
  return [...new Set(v.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s.length >= 32))];
}

export function scanConfig(env: NodeJS.ProcessEnv = process.env): ScanConfig {
  return {
    minTvl: num(env.SCAN_MIN_TVL, 10_000),
    maxTvl: num(env.SCAN_MAX_TVL, 100_000),
    minVol24h: num(env.SCAN_MIN_VOL24H, 25_000),
    maxBinStep: num(env.SCAN_MAX_BIN_STEP, 200),
    minBinStep: num(env.SCAN_MIN_BIN_STEP, 100),
    topN: Math.max(1, Math.min(50, num(env.SCAN_TOP_N, 15))),
    pages: Math.max(1, Math.min(10, num(env.SCAN_PAGES, 3))),
    newPoolHours: num(env.SCAN_NEW_POOL_HOURS, 24),
    minPoolAgeHours: num(env.SCAN_MIN_POOL_AGE_HOURS, 6),
    minHolders: num(env.SCAN_MIN_HOLDERS, 1000),
    maxTop10HolderPct: num(env.SCAN_MAX_TOP10_HOLDER_PCT, 20),
    minMarketCap: num(env.SCAN_MIN_MARKET_CAP, 500_000),
    excludeFreezeAuth: bool(env.SCAN_EXCLUDE_FREEZE_AUTH, true),
    excludeMintAuth: bool(env.SCAN_EXCLUDE_MINT_AUTH, true),
    excludeUnverified: bool(env.SCAN_EXCLUDE_UNVERIFIED, false),
    blacklistMints: parseBlacklistMints(env.SCAN_BLACKLIST_MINTS),
    intervalMinutes: Math.max(1, num(env.SCAN_INTERVAL_MINUTES, 10)),
  };
}

export type Flag = { code: string; why: string };
export type ScanPool = {
  address: string;
  pair: string;
  tokenMint: string;
  binStep: number;
  baseFeePct: number;
  tvl: number;
  vol24h: number;
  fees24h: number;
  feeTvl24hPct: number;
  feeApr: number;
  ageHours: number | null;
  holders: number | null;
  isVerified: boolean | null;
  score: number;
  flags: Flag[];
  meta?: {
    top10HolderPct: number | null;
    marketCapUsd: number | null;
    hasMintAuthority: boolean | null;
    hasFreezeAuthority: boolean | null;
    sources: Record<string, string>;
  };
};
export type DroppedPool = { address: string; pair?: string; tokenMint?: string; reason: string };
export type ScanResult = {
  ts: string;
  source: string;
  config: ScanConfig;
  scanned: number;
  matched: number;
  pools: ScanPool[];
  dropped?: DroppedPool[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

export type MappedPool = Omit<ScanPool, "score" | "flags" | "meta"> & { raw: Raw };

/** datapi row → mapped pool (null if not a SOL pair or Meteora-blacklisted). Pure. */
export function mapPool(p: Raw, now = Date.now()): MappedPool | null {
  const x = p?.token_x, y = p?.token_y;
  if (!x || !y || p.is_blacklisted) return null;
  const solIsX = x.address === SOL, solIsY = y.address === SOL;
  if (!solIsX && !solIsY) return null;
  const tok = solIsY ? x : y;
  const tvl = Number(p.tvl) || 0;
  const fees24h = Number(p.fees?.["24h"]) || 0;
  const feeTvl = Number(p.fee_tvl_ratio?.["24h"]);
  const feeTvl24hPct = Number.isFinite(feeTvl) ? feeTvl : tvl > 0 ? (fees24h / tvl) * 100 : 0;
  const created = Number(p.created_at);
  const holdersN = Number(tok.holders);
  return {
    address: String(p.address),
    pair: `${tok.symbol || "?"}/SOL`,
    tokenMint: String(tok.address),
    binStep: Number(p.pool_config?.bin_step) || 0,
    baseFeePct: Number(p.pool_config?.base_fee_pct) || 0,
    tvl,
    vol24h: Number(p.volume?.["24h"]) || 0,
    fees24h,
    feeTvl24hPct,
    feeApr: feeTvl24hPct * 365,
    ageHours: Number.isFinite(created) && created > 0 ? (now - created) / 3_600_000 : null,
    holders: Number.isFinite(holdersN) && holdersN > 0 ? holdersN : null,
    isVerified: typeof tok.is_verified === "boolean" ? tok.is_verified : null,
    raw: p,
  };
}

/**
 * Cheap hard filters (no RPC). Returns reject reason or null if still a candidate.
 * Missing required age/holders → reject (never treat empty as pass).
 */
export function hardRejectCheap(p: MappedPool, c: ScanConfig): string | null {
  if (c.blacklistMints.includes(p.tokenMint)) return `blacklist_mint:${p.tokenMint.slice(0, 8)}…`;
  if (p.tvl < c.minTvl) return `tvl_below_min:$${Math.round(p.tvl)}<$${c.minTvl}`;
  if (p.tvl > c.maxTvl) return `tvl_above_max:$${Math.round(p.tvl)}>$${c.maxTvl}`;
  if (p.vol24h < c.minVol24h) return `vol24h_below_min:$${Math.round(p.vol24h)}<$${c.minVol24h}`;
  if (p.binStep < c.minBinStep || p.binStep > c.maxBinStep) return `bin_step:${p.binStep} not in [${c.minBinStep},${c.maxBinStep}]`;
  if (p.ageHours == null) return "pool_age_missing:created_at unavailable";
  if (p.ageHours < c.minPoolAgeHours) return `pool_age_below_min:${p.ageHours.toFixed(2)}h<${c.minPoolAgeHours}h`;
  if (p.holders == null) return "holders_missing:datapi holders unavailable";
  if (p.holders < c.minHolders) return `holders_below_min:${p.holders}<${c.minHolders}`;
  if (c.excludeUnverified && p.isVerified === false) return "unverified_token";
  return null;
}

/** Meta-based hard filters. Required meta failures → reject with clear reason. */
export function hardRejectMeta(p: MappedPool, c: ScanConfig, meta: TokenMeta | undefined): string | null {
  if (!meta) return "meta_missing:token metadata not fetched";
  if (meta.failures.includes("mint_account") || meta.hasMintAuthority == null || meta.hasFreezeAuthority == null) {
    return `meta_mint_account_failed:${meta.sources.mintAuthority || "unknown"}`;
  }
  if (c.excludeMintAuth && meta.hasMintAuthority) return "mint_authority_enabled";
  if (c.excludeFreezeAuth && meta.hasFreezeAuthority) return "freeze_authority_enabled";
  if (meta.failures.includes("top10") || meta.top10HolderPct == null) {
    return `meta_top10_failed:${meta.sources.top10 || "unknown"}`;
  }
  if (meta.top10HolderPct > c.maxTop10HolderPct) {
    return `top10_holder_pct:${meta.top10HolderPct.toFixed(2)}%>${c.maxTop10HolderPct}%`;
  }
  if (meta.failures.includes("marketCap") || meta.marketCapUsd == null) {
    return `meta_market_cap_failed:${meta.sources.marketCap || "unknown"}`;
  }
  if (meta.marketCapUsd < c.minMarketCap) {
    return `market_cap_below_min:$${Math.round(meta.marketCapUsd)}<$${c.minMarketCap}`;
  }
  return null;
}

/** @deprecated use hardRejectCheap; kept for older callers/tests that expect boolean. */
export function passes(p: Omit<ScanPool, "score" | "flags"> | MappedPool, c: ScanConfig): boolean {
  return hardRejectCheap(p as MappedPool, c) == null;
}

/** Explained risk flags (soft). Penalty −5 each. Does not drop pools. */
export function riskFlags(p: Omit<ScanPool, "score" | "flags"> & { raw?: Raw }, c: ScanConfig): Flag[] {
  const f: Flag[] = [];
  if (p.tvl < Math.max(c.minTvl * 3, 30_000)) f.push({ code: "LOW_TVL", why: `TVL $${Math.round(p.tvl).toLocaleString("en-US")} kecil → slippage besar, mudah dimanipulasi` });
  if (p.feeApr > 2000 && p.tvl < 100_000) f.push({ code: "APR_VS_TVL", why: `Fee APR ${Math.round(p.feeApr)}% di TVL kecil → kemungkinan lonjakan sesaat, tidak bertahan` });
  if (p.ageHours != null && p.ageHours < c.newPoolHours) f.push({ code: "NEW_POOL", why: `Pool baru (${p.ageHours.toFixed(1)} jam) → data 24h belum lengkap, risiko rug lebih tinggi` });
  const feeVol = p.vol24h > 0 ? (p.fees24h / p.vol24h) * 100 : 0;
  if (p.vol24h > 0 && feeVol < p.baseFeePct * 0.5) f.push({ code: "LOW_FEE_VOL", why: `Fee/volume ${feeVol.toFixed(2)}% < setengah base fee ${p.baseFeePct}% → fee yang didapat LP rendah` });
  if (p.tvl > 0 && p.vol24h / p.tvl > 50) f.push({ code: "VOL_SPIKE", why: `Volume ${Math.round(p.vol24h / p.tvl)}× TVL → aktivitas ekstrem/wash, IL tinggi` });
  if (p.holders != null && p.holders < 500) f.push({ code: "FEW_HOLDERS", why: `Holder sedikit (${p.holders}) → distribusi terkonsentrasi` });
  return f;
}

/** Combined score 0–100: fee APR 40%, fees24h 25%, vol24h 20%, TVL 15%; −5 per risk flag. Pure. */
export function scorePool(p: { feeApr: number; fees24h: number; vol24h: number; tvl: number }, flags: number): number {
  const l = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (Math.log10(Math.max(v, 1)) - lo) / (hi - lo)));
  const s = 40 * l(p.feeApr, 1, 4) + 25 * l(p.fees24h, 2, 5) + 20 * l(p.vol24h, 4, 7) + 15 * l(p.tvl, 4, 7);
  return Math.max(0, Math.round((s - 5 * flags) * 10) / 10);
}

function toScanPool(m: MappedPool, flags: Flag[], meta?: TokenMeta): ScanPool {
  const { raw: _raw, ...rest } = m;
  void _raw;
  return {
    ...rest,
    score: scorePool(m, flags.length),
    flags,
    meta: meta
      ? {
          top10HolderPct: meta.top10HolderPct,
          marketCapUsd: meta.marketCapUsd,
          hasMintAuthority: meta.hasMintAuthority,
          hasFreezeAuthority: meta.hasFreezeAuthority,
          sources: meta.sources,
        }
      : undefined,
  };
}

/**
 * Rank rows with optional pre-fetched token meta.
 * Without metaMap, meta hard-filters are skipped (unit tests of cheap filters only).
 * Production runScan always supplies metaMap.
 */
export function rank(
  rows: Raw[],
  c: ScanConfig,
  now = Date.now(),
  metaMap?: Map<string, TokenMeta>,
): { pools: ScanPool[]; scanned: number; matched: number; dropped: DroppedPool[] } {
  const seen = new Set<string>();
  const out: ScanPool[] = [];
  const dropped: DroppedPool[] = [];
  let scanned = 0;
  const requireMeta = metaMap !== undefined;

  for (const r of rows) {
    const m = mapPool(r, now);
    if (!m || seen.has(m.address)) continue;
    seen.add(m.address);
    scanned++;

    const cheap = hardRejectCheap(m, c);
    if (cheap) {
      dropped.push({ address: m.address, pair: m.pair, tokenMint: m.tokenMint, reason: cheap });
      continue;
    }

    let meta: TokenMeta | undefined;
    if (requireMeta) {
      meta = metaMap!.get(m.tokenMint);
      const metaRej = hardRejectMeta(m, c, meta);
      if (metaRej) {
        dropped.push({ address: m.address, pair: m.pair, tokenMint: m.tokenMint, reason: metaRej });
        continue;
      }
    }

    const flags = riskFlags(m, c);
    out.push(toScanPool(m, flags, meta));
  }
  out.sort((a, b) => b.score - a.score || b.fees24h - a.fees24h);
  return { pools: out.slice(0, c.topN), scanned, matched: out.length, dropped };
}

export async function fetchPools(c: ScanConfig, fetchFn: typeof fetch = fetch): Promise<Raw[]> {
  const rows: Raw[] = [];
  for (let page = 1; page <= c.pages; page++) {
    // server-side TVL floor only; max TVL / other filters applied client-side
    const url = `${API}?page=${page}&page_size=100&sort_by=${encodeURIComponent("volume_24h:desc")}&filter_by=${encodeURIComponent(`tvl>${c.minTvl}`)}`;
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Meteora datapi HTTP ${res.status}`);
    const j = (await res.json()) as { data?: Raw[] };
    const d = j.data || [];
    rows.push(...d);
    if (d.length < 100) break;
  }
  return rows;
}

export function scanFile(dataDir = process.env.DATA_DIR?.trim() || "./data"): string {
  return path.join(dataDir, "scan", "latest.json");
}

export async function runScan(
  opts: {
    config?: ScanConfig;
    fetchFn?: typeof fetch;
    write?: boolean;
    dataDir?: string;
    rpc?: RpcLike;
    /** test hook: skip live meta and inject map */
    metaMap?: Map<string, TokenMeta>;
    skipMeta?: boolean;
  } = {},
): Promise<ScanResult> {
  const c = opts.config ?? scanConfig();
  const rows = await fetchPools(c, opts.fetchFn);

  // cheap pass → unique mints needing meta
  const now = Date.now();
  const candidates: MappedPool[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const m = mapPool(r, now);
    if (!m || seen.has(m.address)) continue;
    seen.add(m.address);
    if (hardRejectCheap(m, c) == null) candidates.push(m);
  }

  let metaMap = opts.metaMap;
  if (!opts.skipMeta && !metaMap) {
    try {
      const rpc = opts.rpc ?? connectionAsRpc(getConnection());
      metaMap = await fetchTokenMetaMany(
        candidates.map((p) => p.tokenMint),
        { rpc, fetchFn: opts.fetchFn },
      );
    } catch (e) {
      log("scan", `token meta batch failed: ${(e as Error).message}`, "warn");
      // every candidate will be dropped with meta_missing / mint_account failed
      metaMap = new Map();
    }
  }

  const r = rank(rows, c, now, opts.skipMeta ? undefined : metaMap);
  const out: ScanResult = {
    ts: new Date().toISOString(),
    source: "dlmm.datapi.meteora.ag+rpc+public-mcap",
    config: c,
    scanned: r.scanned,
    matched: r.matched,
    pools: r.pools,
    dropped: r.dropped.slice(0, 200),
  };
  if (opts.write !== false) {
    const f = scanFile(opts.dataDir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(out, null, 2));
    fs.renameSync(`${f}.tmp`, f);
  }
  return out;
}

export function readLatest(dataDir?: string): ScanResult | null {
  try {
    return JSON.parse(fs.readFileSync(scanFile(dataDir), "utf8")) as ScanResult;
  } catch {
    return null;
  }
}

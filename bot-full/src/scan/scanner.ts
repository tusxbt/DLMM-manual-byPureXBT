/**
 * Read-only DLMM pool scanner (SOL pairs). Public Meteora datapi only — no wallet, no trades.
 * Ranks by a combined score (fee APR, 24h fees, 24h volume, TVL) and attaches explained risk flags.
 */
import fs from "node:fs";
import path from "node:path";

export const SOL = "So11111111111111111111111111111111111111112";
const API = "https://dlmm.datapi.meteora.ag/pools";

export type ScanConfig = {
  minTvl: number;
  minVol24h: number;
  maxBinStep: number;
  minBinStep: number;
  topN: number;
  pages: number;
  newPoolHours: number;
};

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) ? n : d;
};
export function scanConfig(env: NodeJS.ProcessEnv = process.env): ScanConfig {
  return {
    minTvl: num(env.SCAN_MIN_TVL, 10_000),
    minVol24h: num(env.SCAN_MIN_VOL24H, 25_000),
    maxBinStep: num(env.SCAN_MAX_BIN_STEP, 200),
    minBinStep: num(env.SCAN_MIN_BIN_STEP, 1),
    topN: Math.max(1, Math.min(50, num(env.SCAN_TOP_N, 15))),
    pages: Math.max(1, Math.min(10, num(env.SCAN_PAGES, 3))),
    newPoolHours: num(env.SCAN_NEW_POOL_HOURS, 24),
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
  score: number;
  flags: Flag[];
};
export type ScanResult = { ts: string; source: string; config: ScanConfig; scanned: number; matched: number; pools: ScanPool[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

/** datapi row → ScanPool (null if not a SOL pair or blacklisted). Pure. */
export function mapPool(p: Raw, now = Date.now()): Omit<ScanPool, "score" | "flags"> & { raw: Raw } | null {
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
    raw: p,
  };
}

export function passes(p: Omit<ScanPool, "score" | "flags">, c: ScanConfig): boolean {
  return p.tvl >= c.minTvl && p.vol24h >= c.minVol24h && p.binStep <= c.maxBinStep && p.binStep >= c.minBinStep;
}

/** Explained risk flags. Pure. */
export function riskFlags(p: Omit<ScanPool, "score" | "flags"> & { raw?: Raw }, c: ScanConfig): Flag[] {
  const f: Flag[] = [];
  const tok = p.raw ? (p.raw.token_x?.address === SOL ? p.raw.token_y : p.raw.token_x) : null;
  if (p.tvl < Math.max(c.minTvl * 3, 30_000)) f.push({ code: "LOW_TVL", why: `TVL $${Math.round(p.tvl).toLocaleString("en-US")} kecil → slippage besar, mudah dimanipulasi` });
  if (p.feeApr > 2000 && p.tvl < 100_000) f.push({ code: "APR_VS_TVL", why: `Fee APR ${Math.round(p.feeApr)}% di TVL kecil → kemungkinan lonjakan sesaat, tidak bertahan` });
  if (p.ageHours != null && p.ageHours < c.newPoolHours) f.push({ code: "NEW_POOL", why: `Pool baru (${p.ageHours.toFixed(1)} jam) → data 24h belum lengkap, risiko rug lebih tinggi` });
  const feeVol = p.vol24h > 0 ? (p.fees24h / p.vol24h) * 100 : 0;
  if (p.vol24h > 0 && feeVol < p.baseFeePct * 0.5) f.push({ code: "LOW_FEE_VOL", why: `Fee/volume ${feeVol.toFixed(2)}% < setengah base fee ${p.baseFeePct}% → fee yang didapat LP rendah` });
  if (p.tvl > 0 && p.vol24h / p.tvl > 50) f.push({ code: "VOL_SPIKE", why: `Volume ${Math.round(p.vol24h / p.tvl)}× TVL → aktivitas ekstrem/wash, IL tinggi` });
  if (tok && tok.freeze_authority_disabled === false) f.push({ code: "FREEZE_AUTH", why: "Token masih punya freeze authority → token di wallet bisa dibekukan" });
  if (tok && tok.is_verified === false) f.push({ code: "UNVERIFIED", why: "Token belum terverifikasi (Jupiter/Meteora)" });
  if (tok && Number(tok.holders) > 0 && Number(tok.holders) < 500) f.push({ code: "FEW_HOLDERS", why: `Holder sedikit (${tok.holders}) → distribusi terkonsentrasi` });
  return f;
}

/** Combined score 0–100: fee APR (log, 40%), fees24h (25%), vol24h (20%), TVL (15%); −5 per risk flag. Pure. */
export function scorePool(p: { feeApr: number; fees24h: number; vol24h: number; tvl: number }, flags: number): number {
  const l = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (Math.log10(Math.max(v, 1)) - lo) / (hi - lo)));
  const s = 40 * l(p.feeApr, 1, 4) + 25 * l(p.fees24h, 2, 5) + 20 * l(p.vol24h, 4, 7) + 15 * l(p.tvl, 4, 7);
  return Math.max(0, Math.round((s - 5 * flags) * 10) / 10);
}

export function rank(rows: Raw[], c: ScanConfig, now = Date.now()): { pools: ScanPool[]; scanned: number; matched: number } {
  const seen = new Set<string>();
  const out: ScanPool[] = [];
  let scanned = 0;
  for (const r of rows) {
    const m = mapPool(r, now);
    if (!m || seen.has(m.address)) continue;
    seen.add(m.address);
    scanned++;
    if (!passes(m, c)) continue;
    const flags = riskFlags(m, c);
    const { raw: _raw, ...rest } = m;
    void _raw;
    out.push({ ...rest, score: scorePool(m, flags.length), flags });
  }
  out.sort((a, b) => b.score - a.score || b.fees24h - a.fees24h);
  return { pools: out.slice(0, c.topN), scanned, matched: out.length };
}

export async function fetchPools(c: ScanConfig, fetchFn: typeof fetch = fetch): Promise<Raw[]> {
  const rows: Raw[] = [];
  for (let page = 1; page <= c.pages; page++) {
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

export async function runScan(opts: { config?: ScanConfig; fetchFn?: typeof fetch; write?: boolean; dataDir?: string } = {}): Promise<ScanResult> {
  const c = opts.config ?? scanConfig();
  const rows = await fetchPools(c, opts.fetchFn);
  const r = rank(rows, c);
  const out: ScanResult = { ts: new Date().toISOString(), source: "dlmm.datapi.meteora.ag", config: c, scanned: r.scanned, matched: r.matched, pools: r.pools };
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

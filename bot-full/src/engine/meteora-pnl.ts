/**
 * Position PnL from Meteora DLMM datapi — same numbers as the Meteora UI
 * (excludes tx fees and non-refundable rent). Free, no key, 30 RPS.
 * GET https://dlmm.datapi.meteora.ag/positions/{pool}/pnl?user=&status=open|closed|all
 */
import { log } from "../logger.js";

const BASE = process.env.METEORA_DATAPI_URL?.trim() || "https://dlmm.datapi.meteora.ag";

export type TokenAmt = { amount: number | null; usd: number | null };
export type MeteoraPnl = {
  position: string;
  closed: boolean;
  pnlUsd: number | null;
  pnlPct: number | null;
  pnlSol: number | null;
  depositUsd: number | null;
  withdrawUsd: number | null;
  feesUsd: number | null;
  feeX: TokenAmt;
  feeY: TokenAmt;
  /** open: current balance (X+Y) USD, excl. unclaimed fees */
  balanceUsd: number | null;
  unclaimedFeesUsd: number | null;
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const tok = (t: unknown): TokenAmt => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = (t || {}) as any;
  return { amount: num(o.amount), usd: num(o.usd) };
};
const addUsd = (...xs: (number | null)[]): number | null => (xs.some((x) => x == null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parsePnlPosition(p: any): MeteoraPnl {
  const u = p.unrealizedPnl || null;
  const unclaimed = u ? addUsd(tok(u.unclaimedFeeTokenX).usd ?? 0, tok(u.unclaimedFeeTokenY).usd ?? 0) : null;
  const allFees = num(p.allTimeFees?.total?.usd);
  return {
    position: String(p.positionAddress),
    closed: !!p.isClosed,
    pnlUsd: num(p.pnlUsd),
    pnlPct: num(p.pnlPctChange),
    pnlSol: num(p.pnlSol),
    depositUsd: num(p.allTimeDeposits?.total?.usd),
    withdrawUsd: num(p.allTimeWithdrawals?.total?.usd),
    // claimed (all-time) + still unclaimed for open positions
    feesUsd: allFees == null ? null : allFees + (p.isClosed ? 0 : unclaimed ?? 0),
    feeX: tok(p.allTimeFees?.tokenX),
    feeY: tok(p.allTimeFees?.tokenY),
    balanceUsd: u ? num(u.balances) : null,
    unclaimedFeesUsd: unclaimed,
  };
}

export async function fetchPoolPnl(
  pool: string,
  user: string,
  status: "open" | "closed" | "all" = "all",
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, MeteoraPnl>> {
  const out = new Map<string, MeteoraPnl>();
  for (let page = 1; page <= 5; page++) {
    const url = `${BASE}/positions/${pool}/pnl?user=${user}&status=${status}&page=${page}&page_size=100`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetchFn(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = (await res.json()) as any;
      for (const p of j.positions || []) {
        const m = parsePnlPosition(p);
        out.set(m.position, m);
      }
      if (!j.hasNext) break;
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/** One fetch per pool. Failures → pool simply missing (caller falls back to 'estimasi'). */
export async function fetchPnlForPools(pools: string[], user: string, status: "open" | "closed" | "all" = "open"): Promise<Map<string, MeteoraPnl>> {
  const all = new Map<string, MeteoraPnl>();
  await Promise.all(
    [...new Set(pools)].map(async (pool) => {
      try {
        for (const [k, v] of await fetchPoolPnl(pool, user, status)) all.set(k, v);
      } catch (e) {
        log("meteora_pnl", `pool ${pool.slice(0, 6)} failed: ${(e as Error).message}`, "warn");
      }
    }),
  );
  return all;
}

/** After close the indexer may lag: retry until the position shows as closed (≈ up to `tries*delay` ms). */
export async function fetchClosedPnl(pool: string, user: string, position: string, tries = 6, delayMs = 2500): Promise<MeteoraPnl | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const m = (await fetchPoolPnl(pool, user, "all")).get(position);
      if (m?.closed) return m;
    } catch {
      /* retry */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

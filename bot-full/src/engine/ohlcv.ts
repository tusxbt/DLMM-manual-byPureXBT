/**
 * Pool OHLCV from GeckoTerminal public API (free, no key):
 * GET https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/ohlcv/{minute|hour|day}
 *   ?aggregate=N&limit=≤1000&currency=token&token={mint}&before_timestamp=…
 * currency=token + token=<mintX> → price of token X in units of the other token (SOL) — same unit as DLMM range.
 */
export type Candle = { t: number; o: number; h: number; l: number; c: number };

export function pickTimeframe(durationSec: number): { tf: "minute" | "hour" | "day"; agg: number; step: number } {
  const opts = [
    { tf: "minute" as const, agg: 1, step: 60 },
    { tf: "minute" as const, agg: 5, step: 300 },
    { tf: "minute" as const, agg: 15, step: 900 },
    { tf: "hour" as const, agg: 1, step: 3600 },
    { tf: "hour" as const, agg: 4, step: 14400 },
    { tf: "day" as const, agg: 1, step: 86400 },
  ];
  // aim for ~40–150 candles
  return opts.find((o) => durationSec / o.step <= 150) || opts[opts.length - 1];
}

export function parseOhlcv(json: unknown): Candle[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (json as any)?.data?.attributes?.ohlcv_list as number[][] | undefined;
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }))
    .filter((c) => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite) && c.h > 0)
    .sort((a, b) => a.t - b.t);
}

export async function fetchOhlcv(input: {
  pool: string;
  tokenMint?: string;
  fromSec: number;
  toSec: number;
  timeoutMs?: number;
}): Promise<Candle[]> {
  const dur = Math.max(600, input.toSec - input.fromSec);
  const { tf, agg, step } = pickTimeframe(dur);
  const limit = Math.min(1000, Math.ceil(dur / step) + 6);
  const q = new URLSearchParams({ aggregate: String(agg), limit: String(limit), before_timestamp: String(input.toSec + step) });
  if (input.tokenMint) {
    q.set("currency", "token");
    q.set("token", input.tokenMint);
  }
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${input.pool}/ohlcv/${tf}?${q}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
    const all = parseOhlcv(await res.json());
    const from = input.fromSec - step * 3;
    return all.filter((c) => c.t >= from);
  } finally {
    clearTimeout(timer);
  }
}

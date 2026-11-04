/**
 * Pool OHLCV from GeckoTerminal public API (free, no key):
 * GET https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/ohlcv/{minute|hour|day}
 *   ?aggregate=N&limit=≤1000&currency=token&token={mint}&before_timestamp=…
 * currency=token + token=<mintX> → price of token X in units of the other token (SOL) — same unit as DLMM range.
 */
export type Candle = { t: number; o: number; h: number; l: number; c: number };

const TIMEFRAMES = [
  { tf: "minute" as const, agg: 1, step: 60 },
  { tf: "minute" as const, agg: 5, step: 300 },
  { tf: "minute" as const, agg: 15, step: 900 },
  { tf: "hour" as const, agg: 1, step: 3600 },
  { tf: "hour" as const, agg: 4, step: 14400 },
  { tf: "hour" as const, agg: 12, step: 43200 },
  { tf: "day" as const, agg: 1, step: 86400 },
];

/** Smallest GeckoTerminal timeframe giving ≤120 candles (→ ~60–120 for the padded window). */
export function pickTimeframe(durationSec: number): { tf: "minute" | "hour" | "day"; agg: number; step: number } {
  return TIMEFRAMES.find((o) => durationSec / o.step <= 120) || TIMEFRAMES[TIMEFRAMES.length - 1];
}

/** Window around the position: ~15% padding before entry and ~5% after exit/now. */
export function chartWindow(fromSec: number, toSec: number): { from: number; to: number } {
  const dur = Math.max(1800, toSec - fromSec);
  return { from: Math.floor(fromSec - dur * 0.15), to: Math.ceil(toSec + dur * 0.05) };
}

/**
 * GeckoTerminal omits intervals without trades. Forward-fill them as flat candles at the
 * previous close so the time axis is continuous. Leading gap is back-filled with the first open.
 */
export function fillGaps(candles: Candle[], step: number, from: number, to: number): Candle[] {
  if (!candles.length) return [];
  const byT = new Map(candles.map((c) => [Math.floor(c.t / step) * step, c]));
  const start = Math.floor(from / step) * step;
  const end = Math.floor(Math.min(to, candles[candles.length - 1].t + step * 3) / step) * step;
  const out: Candle[] = [];
  let prev: number | null = null;
  for (let t = start; t <= end; t += step) {
    const c = byT.get(t);
    if (c) {
      out.push({ ...c, t });
      prev = c.c;
    } else if (prev != null) {
      out.push({ t, o: prev, h: prev, l: prev, c: prev });
    }
  }
  // back-fill the head (before the first traded candle in window)
  const first = out[0];
  if (first && first.t > start) {
    const head: Candle[] = [];
    for (let t = start; t < first.t; t += step) head.push({ t, o: first.o, h: first.o, l: first.o, c: first.o });
    return [...head, ...out];
  }
  return out;
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
  const w = chartWindow(input.fromSec, input.toSec);
  const { tf, agg, step } = pickTimeframe(w.to - w.from);
  const limit = Math.min(1000, Math.ceil((w.to - w.from) / step) + 10);
  const q = new URLSearchParams({ aggregate: String(agg), limit: String(limit), before_timestamp: String(w.to + step) });
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
    const raw = parseOhlcv(await res.json());
    // include last candle before window so the head can be forward-filled correctly
    const before = raw.filter((c) => c.t < w.from).at(-1);
    const inWin = raw.filter((c) => c.t >= w.from);
    const seed = before ? [{ ...before, t: Math.floor(w.from / step) * step, o: before.c, h: before.c, l: before.c }] : [];
    return fillGaps([...seed, ...inWin], step, w.from, Math.min(w.to, Math.floor(Date.now() / 1000)));
  } finally {
    clearTimeout(timer);
  }
}

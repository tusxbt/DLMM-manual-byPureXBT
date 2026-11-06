import { fmtMoney, currentDisplayCurrency, type DisplayCurrency } from "../display-money.js";
import { getActiveBin, listLivePositions, type LivePosition } from "../engine/dlmm-read.js";
import type { LiveBinBar, LiveSnapshot } from "./types.js";

function short(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** Flat Spot-style bars across [min,max]; active highlighted by client. */
export function barsFromRange(minBin: number, maxBin: number): LiveBinBar[] {
  const lo = Math.min(minBin, maxBin);
  const hi = Math.max(minBin, maxBin);
  const n = Math.max(1, hi - lo + 1);
  // Cap chart width ~61 bars for UI
  const step = n > 61 ? Math.ceil(n / 61) : 1;
  const out: LiveBinBar[] = [];
  for (let id = lo; id <= hi; id += step) {
    out.push({ binId: id, height: 0.72 });
  }
  if (out[out.length - 1]?.binId !== hi) out.push({ binId: hi, height: 0.72 });
  return out;
}

export function snapshotFromLivePosition(
  p: LivePosition,
  opts: { currency?: DisplayCurrency; demo?: boolean; pair?: string; strategy?: string } = {},
): LiveSnapshot {
  const currency = (opts.currency ?? currentDisplayCurrency()) as LiveSnapshot["currency"];
  const minBin = p.min_bin ?? p.active_id ?? 0;
  const maxBin = p.max_bin ?? p.active_id ?? 0;
  const active = p.active_id ?? minBin;
  const money = (usd: number | null | undefined, sign = false) =>
    fmtMoney(usd, { currency, sign, na: "—" });

  return {
    demo: !!opts.demo,
    ts: new Date().toISOString(),
    pair: opts.pair || p.pair || "TOKEN/SOL",
    strategy: opts.strategy || "—",
    positionShort: short(p.position),
    poolShort: short(p.pool),
    activeBinId: active,
    activePrice: p.active_price ?? 0,
    minBinId: minBin,
    maxBinId: maxBin,
    minPrice: p.min_price ?? 0,
    maxPrice: p.max_price ?? 0,
    inRange: p.in_range !== false,
    bins: barsFromRange(minBin, maxBin),
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

/** Hub fetcher: refresh active bin + position economics. Polls only when subscribed. */
export async function fetchLiveSnapshot(args: {
  position: string;
  pool: string;
  currency: LiveSnapshot["currency"];
}): Promise<LiveSnapshot | null> {
  const positions = await listLivePositions();
  const p = positions.find((x) => x.position === args.position);
  if (!p) return null;
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
  return snapshotFromLivePosition(p, { currency: args.currency });
}

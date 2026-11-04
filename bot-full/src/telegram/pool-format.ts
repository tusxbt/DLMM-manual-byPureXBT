/** Compact pool stats lines (TVL, fee tier, LP fees 24h + all-time, fee/TVL). n/a if missing. */
import { fmtNum } from "../format.js";
import { fmtCompactUsd } from "../engine/supply.js";

type PoolLike = {
  tvl?: unknown; bin_step?: unknown; fee_pct?: unknown; volume_24h?: unknown;
  fees_24h?: unknown; fees_total?: unknown; fee_tvl_24h_pct?: unknown;
};
const n = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function poolStatLines(p: PoolLike): string[] {
  const ratio = n(p.fee_tvl_24h_pct);
  return [
    `TVL ${fmtCompactUsd(n(p.tvl))} · Vol 24h ${fmtCompactUsd(n(p.volume_24h))}`,
    `Fee 24h ${fmtCompactUsd(n(p.fees_24h))}${ratio != null ? ` (${fmtNum(ratio, 2)}% TVL)` : ""}`,
    `Total fee ${fmtCompactUsd(n(p.fees_total))}`,
    `Bin step ${n(p.bin_step) ?? "n/a"} · fee ${n(p.fee_pct) != null ? `${fmtNum(Number(p.fee_pct), 2)}%` : "n/a"}`,
  ];
}

/** Short label for a pool button (≤40 chars). */
export function poolButtonLabel(p: PoolLike & { name?: unknown }): string {
  return `${String(p.name ?? "pool")} · TVL ${fmtCompactUsd(n(p.tvl))} · F24 ${fmtCompactUsd(n(p.fees_24h))}`.slice(0, 40);
}

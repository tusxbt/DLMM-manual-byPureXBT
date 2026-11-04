/** Compact pool stats lines (TVL, fee tier, LP fees 24h + all-time, fee/TVL). n/a if missing. */
import { fmtNum } from "../format.js";
import { fmtCompactUsd } from "../engine/supply.js";

type PoolLike = {
  tvl?: unknown; bin_step?: unknown; fee_pct?: unknown; volume_24h?: unknown;
  fees_24h?: unknown; fees_total?: unknown; fee_tvl_24h_pct?: unknown;
};
const n = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** 2 lines: [bin/fee tier, TVL · fees 24h (fee/TVL) · total fees]. */
export function poolStatLines(p: PoolLike): string[] {
  const ratio = n(p.fee_tvl_24h_pct);
  return [
    `bin ${n(p.bin_step) ?? "n/a"} · fee ${n(p.fee_pct) != null ? `${fmtNum(Number(p.fee_pct), 2)}%` : "n/a"}`,
    `TVL ${fmtCompactUsd(n(p.tvl))} · F24 ${fmtCompactUsd(n(p.fees_24h))}${ratio != null ? ` (${fmtNum(ratio, 2)}%)` : ""} · Tot ${fmtCompactUsd(n(p.fees_total))}`,
  ];
}

/** Pool list entry: "1. NAME · bin · fee" + indented stats line. */
export function poolBlock(p: PoolLike & { name?: unknown }, i: number, addr?: string): string {
  const [tier, stats] = poolStatLines(p);
  return [`${i + 1}. **${String(p.name ?? "pool")}** · ${tier}`, `   ${stats}`, addr ? `   \`${addr}\`` : null].filter(Boolean).join("\n");
}

/** Short label for a pool button (≤40 chars). */
export function poolButtonLabel(p: PoolLike & { name?: unknown }): string {
  return `${String(p.name ?? "pool")} · TVL ${fmtCompactUsd(n(p.tvl))} · V24 ${fmtCompactUsd(n(p.volume_24h))}`.slice(0, 40);
}

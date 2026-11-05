/** Short Indonesian /scan list (read-only, USD). */
import type { ScanResult } from "./scanner.js";

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);

export function scanText(r: ScanResult, top = 10, kst = true): string {
  const t = new Date(r.ts);
  const when = kst ? t.toLocaleString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short", hour12: false }) + " KST" : r.ts;
  const L = [`🔎 **Scan pool DLMM (SOL)** · ${when}`, `${r.matched} lolos filter dari ${r.scanned} pool · TVL ≥ ${usd(r.config.minTvl)} · Vol ≥ ${usd(r.config.minVol24h)} · bin ≤ ${r.config.maxBinStep}`, ""];
  r.pools.slice(0, top).forEach((p, i) => {
    L.push(`${i + 1}. **${p.pair}** · bin ${p.binStep} · fee ${p.baseFeePct}% · skor ${p.score}`);
    L.push(`   TVL ${usd(p.tvl)} · Vol ${usd(p.vol24h)} · F24 ${usd(p.fees24h)} · APR ${Math.round(p.feeApr)}%${p.flags.length ? ` · ⚠️ ${p.flags.map((f) => f.code).join(",")}` : ""}`);
    L.push(`   \`${p.address}\``);
  });
  if (!r.pools.length) L.push("Tidak ada pool yang lolos filter.");
  L.push("", "Info saja — bukan saran, tidak ada transaksi.");
  return L.join("\n");
}

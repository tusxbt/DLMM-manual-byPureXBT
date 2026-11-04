/** Pure renderer for the /add Preview (Confirm) message — testable + sampled in ui-samples.md. */
import { fmtNum, fmtUsd } from "../format.js";
import { screen, section, kv } from "./layout.js";
import { fmtCompactUsd } from "../engine/supply.js";
import { fmtTinyPrice } from "./positions-view.js";

export type PreviewData = {
  pool: string;
  side: string;
  strategy: string;
  amount: string;
  mix?: { pct: number; primaryText: string; spotText: string } | null;
  bins: number;
  below: number;
  above: number;
  downPct: number;
  upPct: number;
  minPrice: number | null;
  maxPrice: number | null;
  solUsd?: number | null;
  mcMin: number | null;
  mcMax: number | null;
  mcNow: number | null;
  clamped?: boolean;
  costUsd: number;
  capUsd: number;
  slippagePct: number;
  wide?: { txCount: number; positionRentSol: number; binArrayRentSol: number; binArraysCount: number } | null;
  position: string;
  dryRun: boolean;
  ttlSec: number;
};

export function renderAddPreview(d: PreviewData): string {
  const usd = (x: number | null) => (x != null && d.solUsd ? ` ($${fmtTinyPrice(x * d.solUsd)})` : "");
  return screen(
    `👀 Preview Add LP`,
    section(null, [kv("Pool", d.pool), kv("Mode", d.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE")]),
    section("💵 Amount", [
      kv("Total", d.amount),
      kv("Sisi", d.side),
      kv("Strategi", d.strategy),
      d.mix ? kv(`BidAsk ${d.mix.pct}%`, d.mix.primaryText, 11) : null,
      d.mix ? kv(`Spot ${100 - d.mix.pct}%`, d.mix.spotText, 11) : null,
      kv("Nilai", `${fmtUsd(d.costUsd)} / cap ${fmtUsd(d.capUsd)}`),
    ]),
    section("📐 Range", [
      kv("Bins", `${d.bins} (${d.below}↓ ${d.above}↑)`),
      kv("Persen", `−${fmtNum(d.downPct, 1)}% / +${fmtNum(d.upPct, 1)}%`),
      d.minPrice != null ? kv("Min", `${fmtTinyPrice(d.minPrice)}${usd(d.minPrice)}`) : null,
      d.maxPrice != null ? kv("Max", `${fmtTinyPrice(d.maxPrice)}${usd(d.maxPrice)}`) : null,
      kv("MC", d.mcMin != null || d.mcMax != null ? `${fmtCompactUsd(d.mcMin)}–${fmtCompactUsd(d.mcMax)}` : "n/a"),
      d.mcNow != null ? kv("MC now", fmtCompactUsd(d.mcNow)) : null,
      d.clamped ? "⚠️ Range dipotong ke batas" : null,
    ]),
    section("🧾 Biaya", [
      kv("Tx", String(d.wide ? d.wide.txCount : 1)),
      d.wide ? kv("Rent pos", `≈${fmtNum(d.wide.positionRentSol, 4)} SOL`) : kv("Rent pos", "≈0.057 SOL"),
      "  (kembali saat close)",
      d.wide ? kv("Bin array", `≈${fmtNum(d.wide.binArrayRentSol, 4)} SOL`) : null,
      d.wide ? "  (tidak kembali)" : null,
      kv("Slippage", `${d.slippagePct}%`),
    ]),
    section(null, ["📍 Posisi baru", `\`${d.position}\``, `⏳ Konfirmasi ${d.ttlSec}s`]),
  );
}

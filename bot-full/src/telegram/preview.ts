/** Pure renderer for the /add Preview (Confirm) message — testable + sampled in ui-samples.md. */
import { fmtNum, fmtUsd } from "../format.js";
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
  slippagePct: number;
  wide?: { txCount: number; positionRentSol: number; binArrayRentSol: number; binArraysCount: number } | null;
  /** rent quote for any deploy (single-tx too) */
  rent?: { positionRentSol: number; binArrayRentSol: number; binArraysCount: number } | null;
  funds?: { needSol: number; haveSol: number; feeBufferSol: number; shortSol: number; ok: boolean } | null;
  position: string;
  dryRun: boolean;
  ttlSec: number;
};

/** Warning block for new (non-refundable) bin arrays; null when none. */
export function binArrayWarning(rent: PreviewData["rent"]): string | null {
  if (!rent || !Number.isFinite(rent.binArrayRentSol) || rent.binArrayRentSol <= 0) return null;
  const n = Number.isFinite(rent.binArraysCount) && rent.binArraysCount > 0 ? rent.binArraysCount : 1;
  const each = rent.binArrayRentSol / n;
  return `⚠️ **Bin array baru: ${n} × ≈${fmtNum(each, 4)} SOL (tidak kembali)**\nSisakan SOL ekstra di wallet.`;
}

export function fundsLines(f: PreviewData["funds"]): string | null {
  if (!f) return null;
  if (f.ok) return `✅ Saldo SOL cukup: ${fmtNum(f.haveSol, 4)} / butuh ≈${fmtNum(f.needSol, 4)}`;
  return [
    `⛔ **Saldo SOL kurang ≈${fmtNum(f.shortSol, 4)} SOL**`,
    `Punya ${fmtNum(f.haveSol, 4)} · butuh ≈${fmtNum(f.needSol, 4)}`,
    `(amount + rent posisi + bin array + buffer fee ${fmtNum(f.feeBufferSol, 3)})`,
  ].join("\n");
}

export function renderAddPreview(d: PreviewData): string {
  const rent = d.rent ?? (d.wide ? d.wide : null);
  const usdTxt = Number.isFinite(d.costUsd) ? ` (${fmtUsd(d.costUsd)})` : "";
  const txs = d.wide ? d.wide.txCount : 1;
  const posRent = rent && Number.isFinite(rent.positionRentSol) ? fmtNum(rent.positionRentSol, 3) : "0.057";
  const pct = d.downPct > 0 && d.upPct > 0
    ? `−${fmtNum(d.downPct, 1)}%/+${fmtNum(d.upPct, 1)}%`
    : d.upPct > 0 ? `+${fmtNum(d.upPct, 1)}%` : `−${fmtNum(d.downPct, 1)}%`;
  const range = d.minPrice != null && d.maxPrice != null ? `${fmtTinyPrice(d.minPrice)}–${fmtTinyPrice(d.maxPrice)}` : "range n/a";
  const ba = binArrayWarning(rent);
  const body = [
    `💵 ${d.amount}${usdTxt} · ${d.strategy} · ${d.side}`,
    d.mix ? `🔀 BidAsk ${d.mix.pct}% ${d.mix.primaryText} · Spot ${100 - d.mix.pct}% ${d.mix.spotText}` : null,
    `📐 ${range} · ${d.bins} bins (${pct})${d.clamped ? " ⚠️ dipotong" : ""}`,
    d.mcMin != null || d.mcMax != null
      ? `🏷 MC ${fmtCompactUsd(d.mcMin)}–${fmtCompactUsd(d.mcMax)}${d.mcNow != null ? ` (now ${fmtCompactUsd(d.mcNow)})` : ""}`
      : null,
    `🧾 ${txs} tx · rent ≈${posRent} SOL (kembali) · slip ${d.slippagePct}%`,
  ].filter(Boolean).join("\n");
  const funds = d.funds && !d.funds.ok ? fundsLines(d.funds) : null;
  return [`👀 **${d.pool}** · ${d.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"}`, body, ba, funds, `⏳ Konfirmasi ${d.ttlSec}s`]
    .filter(Boolean)
    .join("\n\n");
}

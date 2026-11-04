/**
 * Pure state + rendering for the single editable /add panel.
 * No network / Telegram side effects here so it can be unit-tested.
 */
import { InlineKeyboard } from "grammy";
import { fmtNum, fmtUsd, shortAddr } from "../format.js";
import { getStrategy, listStrategies, requireStrategy } from "../strategies/index.js";

export type PanelRange =
  | { kind: "preset"; presetId: string; downPct: number; upPct: number }
  | { kind: "bins"; below: number; above: number }
  | { kind: "price"; min: number; max: number };

export type AddPanelState = {
  pool?: Record<string, unknown>;
  amountSol?: number;
  amountToken?: number;
  side: "one_sided_sol" | "two_sided";
  strategyId: string;
  range: PanelRange;
};

export const DEFAULT_STRATEGY = "bid_ask";

export function defaultPanel(pool?: Record<string, unknown>): AddPanelState {
  const strat = getStrategy(DEFAULT_STRATEGY) || listStrategies()[0];
  const preset = strat.rangePresets.find((p) => p.id === "medium") || strat.rangePresets[0];
  return {
    pool,
    side: strat.defaultSide,
    strategyId: strat.id,
    range: { kind: "preset", presetId: preset.id, downPct: preset.downPct, upPct: preset.upPct },
  };
}

/** Switch strategy; keep preset id if new strategy has the same id (re-read pct). */
export function setStrategy(p: AddPanelState, id: string): AddPanelState {
  const strat = requireStrategy(id);
  let range = p.range;
  if (range.kind === "preset") {
    const pr =
      strat.rangePresets.find((x) => x.id === (range as { presetId: string }).presetId) || strat.rangePresets[0];
    range = { kind: "preset", presetId: pr.id, downPct: pr.downPct, upPct: pr.upPct };
  }
  return { ...p, strategyId: strat.id, range };
}

export function setRangePreset(p: AddPanelState, presetId: string): AddPanelState {
  const pr = requireStrategy(p.strategyId).rangePresets.find((x) => x.id === presetId);
  if (!pr) throw new Error(`Preset tidak ada: ${presetId}`);
  return { ...p, range: { kind: "preset", presetId: pr.id, downPct: pr.downPct, upPct: pr.upPct } };
}

export function parsePositiveNumber(text: string): number | null {
  const n = Number(String(text).trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseBins(text: string): { below: number; above: number } | null {
  const parts = text.trim().split(/\s+/).map(Number);
  const below = parts[0];
  const above = parts[1] ?? 0;
  if (!Number.isInteger(below) || !Number.isInteger(above) || below < 0 || above < 0) return null;
  if (below + above < 1) return null;
  return { below, above };
}

export function parsePriceRange(text: string): { min: number; max: number } | null {
  const parts = text.trim().replace(/,/g, ".").split(/\s+/).map(Number);
  if (parts.length < 2 || !parts.every((x) => Number.isFinite(x) && x > 0) || parts[0] >= parts[1]) return null;
  return { min: parts[0], max: parts[1] };
}

export function rangeLabel(r: PanelRange): string {
  if (r.kind === "preset") return `${r.presetId} (−${fmtNum(r.downPct, 1)}% / +${fmtNum(r.upPct, 1)}%)`;
  if (r.kind === "bins") return `custom bins ${r.below} bawah / ${r.above} atas`;
  return `harga ${fmtNum(r.min, 8)} – ${fmtNum(r.max, 8)}`;
}

export function modeLabel(side: AddPanelState["side"]): string {
  return side === "one_sided_sol" ? "One-sided SOL" : "Two-sided";
}

/** Returns list of missing items; empty = ready to deploy. */
export function panelMissing(p: AddPanelState): string[] {
  const m: string[] = [];
  if (!p.pool?.pool) m.push("Pool");
  if (!p.amountSol || p.amountSol <= 0) m.push("Amount");
  return m;
}

export function renderPanelText(
  p: AddPanelState,
  opts: { liqSlippagePct: number; maxPositionUsd: number; dryRun: boolean; note?: string },
): string {
  const pool = p.pool;
  const strat = getStrategy(p.strategyId);
  const missing = panelMissing(p);
  return [
    "🚀 Add LP — panel",
    "",
    `🏊 Pool: ${pool ? `${pool.name} (${shortAddr(String(pool.pool))})` : "— belum dipilih"}`,
    pool ? `     step ${pool.bin_step} | fee ${fmtNum(Number(pool.fee_pct), 2)}% | TVL ${fmtUsd(Number(pool.tvl))}` : null,
    `💵 Amount: ${p.amountSol ? `${fmtNum(p.amountSol)} SOL` : "— belum diisi"}` +
      (p.side === "two_sided" ? ` + token ${fmtNum(p.amountToken ?? 0)}` : ""),
    `🧭 Mode: ${modeLabel(p.side)}`,
    `📐 Strategi: ${strat?.label ?? p.strategyId}`,
    `📏 Range: ${rangeLabel(p.range)}`,
    `🎚 Slippage LIQ: ${opts.liqSlippagePct}%`,
    "",
    `Cap posisi ${fmtUsd(opts.maxPositionUsd)} | ${opts.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"}`,
    missing.length ? `⚠️ Lengkapi: ${missing.join(", ")}` : "✅ Siap deploy — tekan 🚀 Deploy (lanjut ke Confirm 60s).",
    opts.note ? `\nℹ️ ${opts.note}` : null,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

export function panelKeyboard(p: AddPanelState): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("✏️ Pool", "ap:edit:pool")
    .text("✏️ Amount", "ap:edit:amount")
    .row()
    .text("✏️ Mode", "ap:edit:mode")
    .text("✏️ Strategi", "ap:edit:strat")
    .row()
    .text("✏️ Range", "ap:edit:range")
    .text("✏️ Slippage", "ap:edit:slip")
    .row();
  if (p.side === "two_sided") kb.text("✏️ Amount token", "ap:edit:token").row();
  kb.text(panelMissing(p).length ? "🚀 Deploy (belum lengkap)" : "🚀 Deploy", "ap:deploy").text("❌ Batal", "ap:cancel");
  return kb;
}

export function strategyPickerKeyboard(current: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of listStrategies()) kb.text(`${s.id === current ? "✅ " : ""}${s.label}`, `ap:set:strat:${s.id}`).row();
  return kb.text("⬅️ Kembali", "ap:back");
}

export function modePickerKeyboard(current: AddPanelState["side"]): InlineKeyboard {
  return new InlineKeyboard()
    .text(`${current === "one_sided_sol" ? "✅ " : ""}One-sided SOL`, "ap:set:mode:one_sided_sol")
    .text(`${current === "two_sided" ? "✅ " : ""}Two-sided`, "ap:set:mode:two_sided")
    .row()
    .text("⬅️ Kembali", "ap:back");
}

export function rangePickerKeyboard(p: AddPanelState): InlineKeyboard {
  const kb = new InlineKeyboard();
  const cur = p.range.kind === "preset" ? p.range.presetId : "";
  for (const pr of requireStrategy(p.strategyId).rangePresets) {
    kb.text(`${pr.id === cur ? "✅ " : ""}${pr.label}`, `ap:set:rng:${pr.id}`).row();
  }
  return kb
    .text("✏️ Custom bins", "ap:set:rng:_bins")
    .text("✏️ Custom harga", "ap:set:rng:_price")
    .row()
    .text("⬅️ Kembali", "ap:back");
}

export function amountPickerKeyboard(presets: number[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  presets.forEach((a, i) => kb.text(`${a} SOL`, `ap:set:amt:${i}`));
  return kb.row().text("✏️ Ketik manual", "ap:set:amt:manual").text("⬅️ Kembali", "ap:back");
}

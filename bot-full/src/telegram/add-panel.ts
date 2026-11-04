/**
 * Pure state + rendering for the single editable /add panel.
 * No network / Telegram side effects here so it can be unit-tested.
 */
import { InlineKeyboard } from "grammy";
import { fmtNum, fmtUsd, shortAddr } from "../format.js";
import { getStrategy, listStrategies, requireStrategy } from "../strategies/index.js";

export const MAX_BINS_PER_POSITION = 69;

export type BinPresets = { narrow: number; medium: number; wide: number };
export const DEFAULT_BIN_PRESETS: BinPresets = { narrow: 20, medium: 40, wide: 69 };
export const PRESET_IDS = ["narrow", "medium", "wide"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type PanelRange =
  | { kind: "preset"; presetId: PresetId; bins: number }
  | { kind: "bins"; below: number; above: number }
  | { kind: "price"; min: number; max: number };

export type AddPanelState = {
  pool?: Record<string, unknown>;
  /** Cached active price (quote per token) + SOL/USD at pool selection, for display only. */
  activePrice?: number;
  solUsd?: number;
  amountSol?: number;
  amountToken?: number;
  side: "one_sided_sol" | "two_sided";
  strategyId: string;
  range: PanelRange;
};

export const DEFAULT_STRATEGY = "bid_ask";

export function clampBins(n: number): number {
  return Math.min(MAX_BINS_PER_POSITION, Math.max(1, Math.floor(n)));
}

export function defaultPanel(pool?: Record<string, unknown>, presets: BinPresets = DEFAULT_BIN_PRESETS): AddPanelState {
  const strat = getStrategy(DEFAULT_STRATEGY) || listStrategies()[0];
  return {
    pool,
    side: strat.defaultSide,
    strategyId: strat.id,
    range: { kind: "preset", presetId: "medium", bins: clampBins(presets.medium) },
  };
}

export function setStrategy(p: AddPanelState, id: string): AddPanelState {
  const strat = requireStrategy(id);
  return { ...p, strategyId: strat.id };
}

export function setRangePreset(p: AddPanelState, presetId: string, presets: BinPresets = DEFAULT_BIN_PRESETS): AddPanelState {
  if (!(PRESET_IDS as readonly string[]).includes(presetId)) throw new Error(`Preset tidak ada: ${presetId}`);
  const id = presetId as PresetId;
  return { ...p, range: { kind: "preset", presetId: id, bins: clampBins(presets[id]) } };
}

export type ComputedRange = {
  below: number;
  above: number;
  total: number;
  downPct: number;
  upPct: number;
  minPrice: number | null;
  maxPrice: number | null;
  /** true if a custom price range was cut down to fit MAX_BINS_PER_POSITION */
  clamped: boolean;
  /** error that blocks deploy */
  error?: string;
};

/** Split N bins: one-sided SOL → all below active; two-sided → half/half. */
export function splitBins(total: number, side: AddPanelState["side"]): { below: number; above: number } {
  if (side === "one_sided_sol") return { below: total, above: 0 };
  const above = Math.floor(total / 2);
  return { below: total - above, above };
}

export function computeRange(p: AddPanelState, binStep: number, activePrice?: number | null): ComputedRange {
  const r = 1 + (binStep > 0 ? binStep / 10_000 : 0);
  let below: number;
  let above: number;
  let clamped = false;
  let error: string | undefined;
  if (p.range.kind === "preset") {
    ({ below, above } = splitBins(clampBins(p.range.bins), p.side));
  } else if (p.range.kind === "bins") {
    below = p.range.below;
    above = p.range.above;
    if (below + above > MAX_BINS_PER_POSITION)
      error = `Range ${below + above} bins > ${MAX_BINS_PER_POSITION} (batas 1 posisi). Kecilkan bins.`;
  } else {
    if (!activePrice || r <= 1) {
      below = 0;
      above = 0;
      error = "Harga aktif pool belum diketahui — pilih ulang pool.";
    } else {
      below = activePrice > p.range.min ? Math.ceil(Math.log(activePrice / p.range.min) / Math.log(r)) : 0;
      above = p.range.max > activePrice ? Math.ceil(Math.log(p.range.max / activePrice) / Math.log(r)) : 0;
      if (below + above > MAX_BINS_PER_POSITION) {
        clamped = true;
        // keep the side closest to active price, trim the far edges proportionally
        const scale = MAX_BINS_PER_POSITION / (below + above);
        const nb = Math.floor(below * scale);
        above = MAX_BINS_PER_POSITION - nb > above ? above : MAX_BINS_PER_POSITION - nb;
        below = nb;
      }
    }
  }
  if (!error && below + above < 1) error = "Range minimal 1 bin.";
  const downPct = (1 - Math.pow(r, -below)) * 100;
  const upPct = (Math.pow(r, above) - 1) * 100;
  return {
    below,
    above,
    total: below + above,
    downPct,
    upPct,
    minPrice: activePrice ? activePrice * Math.pow(r, -below) : null,
    maxPrice: activePrice ? activePrice * Math.pow(r, above) : null,
    clamped,
    error,
  };
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
  if (r.kind === "preset") return `${r.presetId} (${r.bins} bins)`;
  if (r.kind === "bins") return `custom ${r.below} bawah / ${r.above} atas`;
  return `custom harga ${fmtNum(r.min, 8)} – ${fmtNum(r.max, 8)}`;
}

export function rangeDetailLines(c: ComputedRange, solUsd?: number | null): string[] {
  const usd = (x: number | null) => (x != null && solUsd ? ` (${fmtUsd(x * solUsd)})` : "");
  const lines = [
    `     ${c.total} bins (${c.below} bawah / ${c.above} atas) | −${fmtNum(c.downPct, 2)}% / +${fmtNum(c.upPct, 2)}%`,
  ];
  if (c.minPrice != null && c.maxPrice != null)
    lines.push(`     harga ${fmtNum(c.minPrice, 10)}${usd(c.minPrice)} → ${fmtNum(c.maxPrice, 10)}${usd(c.maxPrice)} SOL`);
  if (c.clamped) lines.push(`     ⚠️ Custom harga dipotong ke ${MAX_BINS_PER_POSITION} bins (batas 1 posisi).`);
  if (c.error) lines.push(`     ⛔ ${c.error}`);
  return lines;
}

export function modeLabel(side: AddPanelState["side"]): string {
  return side === "one_sided_sol" ? "One-sided SOL" : "Two-sided";
}

/** Returns list of missing items; empty = ready to deploy. */
export function panelMissing(p: AddPanelState): string[] {
  const m: string[] = [];
  if (!p.pool?.pool) m.push("Pool");
  if (!p.amountSol || p.amountSol <= 0) m.push("Amount");
  if (p.pool?.pool) {
    const c = computeRange(p, Number(p.pool.bin_step || 0), p.activePrice);
    if (c.error) m.push("Range");
  }
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
    ...(pool ? rangeDetailLines(computeRange(p, Number(pool.bin_step || 0), p.activePrice), p.solUsd) : []),
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

export function rangePickerKeyboard(p: AddPanelState, presets: BinPresets = DEFAULT_BIN_PRESETS): InlineKeyboard {
  const kb = new InlineKeyboard();
  const cur = p.range.kind === "preset" ? p.range.presetId : "";
  const step = Number(p.pool?.bin_step || 0);
  for (const id of PRESET_IDS) {
    const bins = clampBins(presets[id]);
    let extra = "";
    if (step > 0) {
      const c = computeRange({ ...p, range: { kind: "preset", presetId: id, bins } }, step, p.activePrice);
      extra = ` ≈ −${fmtNum(c.downPct, 1)}%` + (c.above ? `/+${fmtNum(c.upPct, 1)}%` : "");
    }
    kb.text(`${id === cur ? "✅ " : ""}${id[0].toUpperCase()}${id.slice(1)} ${bins} bins${extra}`, `ap:set:rng:${id}`).row();
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

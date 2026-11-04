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

export type PanelSide = "one_sided_sol" | "one_sided_token" | "two_sided";

/** SOL kept aside for rent + fees when using Max. */
export const SOL_RESERVE = 0.05;

export type AddPanelState = {
  pool?: Record<string, unknown>;
  /** Cached active price (quote per token) + SOL/USD at pool selection, for display only. */
  activePrice?: number;
  solUsd?: number;
  amountSol?: number;
  amountToken?: number;
  side: PanelSide;
  /** Wallet balances cached at pool selection (display + % buttons). */
  solBalance?: number;
  tokenBalance?: number;
  tokenUsd?: number;
  /** Amount chosen as % of balance (for display), null = manual/preset. */
  amountPct?: number | null;
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
  if (side === "one_sided_token") return { below: 0, above: total };
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

export function modeLabel(side: PanelSide): string {
  if (side === "one_sided_sol") return "SOL side · di bawah harga (order beli)";
  if (side === "one_sided_token") return "Token side · di atas harga (order jual)";
  return "Double · dua sisi";
}

export function tokenSymbol(p: AddPanelState): string {
  const t = (p.pool?.token_x || {}) as { symbol?: string };
  return t.symbol || String(p.pool?.name || "TOKEN").split("-")[0] || "TOKEN";
}

export function tokenMint(p: AddPanelState): string {
  return String(((p.pool?.token_x || {}) as { mint?: string }).mint || "");
}

export function hasToken(p: AddPanelState): boolean {
  return (p.tokenBalance ?? 0) > 0;
}

/** Amount (UI) available for a %-of-balance button. pct=100 = Max (SOL keeps reserve). */
export function amountFromPct(p: AddPanelState, pct: number): { sol: number; token: number } {
  const f = Math.min(100, Math.max(0, pct)) / 100;
  const solAvail = Math.max(0, (p.solBalance ?? 0) - SOL_RESERVE);
  const tokAvail = p.tokenBalance ?? 0;
  const round = (x: number) => Math.floor(x * 1e6) / 1e6;
  if (p.side === "one_sided_sol") return { sol: round(solAvail * f), token: 0 };
  if (p.side === "one_sided_token") return { sol: 0, token: round(tokAvail * f) };
  return { sol: round(solAvail * f), token: round(tokAvail * f) };
}

/** Estimated USD cost of the deposit; null when a token price is needed but unknown. */
export function depositUsd(p: AddPanelState): number | null {
  const sol = p.side === "one_sided_token" ? 0 : p.amountSol ?? 0;
  const tok = p.side === "one_sided_sol" ? 0 : p.amountToken ?? 0;
  if (tok > 0 && !(p.tokenUsd && p.tokenUsd > 0)) return null;
  return sol * (p.solUsd ?? 0) + tok * (p.tokenUsd ?? 0);
}

export function amountText(p: AddPanelState): string {
  const sym = tokenSymbol(p);
  const pct = p.amountPct ? ` (${p.amountPct === 100 ? "Max" : `${p.amountPct}%`} saldo)` : "";
  if (p.side === "one_sided_sol") return p.amountSol ? `${fmtNum(p.amountSol)} SOL${pct}` : "— belum diisi";
  if (p.side === "one_sided_token") return p.amountToken ? `${fmtNum(p.amountToken)} ${sym}${pct}` : "— belum diisi";
  if (!p.amountSol && !p.amountToken) return "— belum diisi";
  return `${fmtNum(p.amountSol ?? 0)} SOL + ${fmtNum(p.amountToken ?? 0)} ${sym}${pct}`;
}

/** Returns list of missing items; empty = ready to deploy. */
export function panelMissing(p: AddPanelState): string[] {
  const m: string[] = [];
  if (!p.pool?.pool) m.push("Pool");
  const sol = p.amountSol ?? 0;
  const tok = p.amountToken ?? 0;
  const okAmt =
    p.side === "one_sided_sol" ? sol > 0 : p.side === "one_sided_token" ? tok > 0 : sol > 0 || tok > 0;
  if (!okAmt) m.push("Amount");
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
  const sym = pool ? tokenSymbol(p) : "token";
  const missing = panelMissing(p);
  const deposit = p.side === "one_sided_sol" ? "SOL" : p.side === "one_sided_token" ? sym : `SOL + ${sym}`;
  const bal =
    p.side === "one_sided_sol"
      ? `${fmtNum(p.solBalance ?? 0)} SOL`
      : p.side === "one_sided_token"
        ? `${fmtNum(p.tokenBalance ?? 0)} ${sym}`
        : `${fmtNum(p.solBalance ?? 0)} SOL · ${fmtNum(p.tokenBalance ?? 0)} ${sym}`;
  let rangeLine = `Range: ${rangeLabel(p.range)}`;
  const extra: string[] = [];
  if (pool) {
    const c = computeRange(p, Number(pool.bin_step || 0), p.activePrice);
    rangeLine = `Range: ${c.total} bins (−${fmtNum(c.downPct, 1)}% → +${fmtNum(c.upPct, 1)}%)`;
    if (c.minPrice != null && c.maxPrice != null) {
      const u = (x: number) => (p.solUsd ? ` ($${fmtNum(x * p.solUsd, 6)})` : "");
      extra.push(`Harga: ${fmtNum(c.minPrice, 8)}${u(c.minPrice)} → ${fmtNum(c.maxPrice, 8)}${u(c.maxPrice)} SOL`);
    }
    if (c.clamped) extra.push(`⚠️ Custom harga dipotong ke ${MAX_BINS_PER_POSITION} bins.`);
    if (c.error) extra.push(`⛔ ${c.error}`);
  }
  const usd = depositUsd(p);
  return [
    pool ? `🎯 Setup ${sym} · ${pool.name}` : "🎯 Setup — pilih pool dulu",
    pool
      ? `${sym} · fee ${fmtNum(Number(pool.fee_pct), 2)}% · step ${pool.bin_step} · TVL ${fmtUsd(Number(pool.tvl))}`
      : null,
    `Deposit: ${deposit}`,
    `Balance: ${bal}`,
    "",
    `Sisi: ${modeLabel(p.side)}`,
    `Bentuk: ${strat?.label ?? p.strategyId}`,
    rangeLine,
    ...extra,
    `Amount: ${amountText(p)}` + (usd ? ` ≈ ${fmtUsd(usd)}` : ""),
    `Slippage: ${opts.liqSlippagePct}% · cap ${fmtUsd(opts.maxPositionUsd)} · ${opts.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"}`,
    "",
    missing.length
      ? `Pilih range & amount → 👀 Preview. (kurang: ${missing.join(", ")})`
      : "✅ Siap — tekan 👀 Preview untuk konfirmasi.",
    pool && !hasToken(p) ? `💡 Token side / Double tidak tersedia — wallet belum memegang ${sym}.` : null,
    opts.note ? `ℹ️ ${opts.note}` : null,
    pool ? `\nℹ️ Pool ${shortAddr(String(pool.pool), 6)}` : null,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

const tick = (on: boolean, label: string) => (on ? `✓ ${label}` : label);

export function panelKeyboard(
  p: AddPanelState,
  opts: { binPresets?: BinPresets; amountPresets?: number[] } = {},
): InlineKeyboard {
  const presets = opts.binPresets ?? DEFAULT_BIN_PRESETS;
  const kb = new InlineKeyboard();
  for (const st of listStrategies()) kb.text(tick(st.id === p.strategyId, st.label), `ap:set:strat:${st.id}`);
  kb.row();
  kb.text(tick(p.side === "one_sided_sol", "SOL"), "ap:set:mode:one_sided_sol");
  kb.text(tick(p.side === "one_sided_token", "Token"), "ap:set:mode:one_sided_token");
  kb.text(tick(p.side === "two_sided", "Double"), "ap:set:mode:two_sided");
  kb.row();
  const cur = p.range.kind === "preset" ? p.range.presetId : "";
  for (const id of PRESET_IDS) kb.text(tick(id === cur, `${clampBins(presets[id])}b`), `ap:set:rng:${id}`);
  kb.row();
  if (p.side === "one_sided_sol") {
    (opts.amountPresets ?? []).slice(0, 3).forEach((a, i) => kb.text(tick(p.amountSol === a && !p.amountPct, `${a}`), `ap:set:amt:${i}`));
  }
  for (const pct of [25, 50, 100]) kb.text(tick(p.amountPct === pct, pct === 100 ? "Max" : `${pct}%`), `ap:set:pct:${pct}`);
  kb.row();
  kb.text("✏️ Range", "ap:edit:range").text("✏️ Nominal", "ap:edit:amount").text("👀 Preview", "ap:deploy").row();
  kb.text("← Pools", "ap:pools").text("🏠 Home", "ap:home");
  return kb;
}

export function rangePickerKeyboard(p: AddPanelState, presets: BinPresets = DEFAULT_BIN_PRESETS): InlineKeyboard {
  const kb = new InlineKeyboard();
  const cur = p.range.kind === "preset" ? p.range.presetId : "";
  for (const id of PRESET_IDS) kb.text(tick(id === cur, `${clampBins(presets[id])}b`), `ap:set:rng:${id}`);
  return kb
    .row()
    .text("✏️ Bins", "ap:set:rng:_bins")
    .text("✏️ Harga", "ap:set:rng:_price")
    .row()
    .text("✏️ Slippage", "ap:edit:slip")
    .text("⬅️ Panel", "ap:back");
}

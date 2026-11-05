import { DEFAULT_RANGE_PCT } from "../store/settings.js";
import { marketCap, fmtCompactUsd } from "../engine/supply.js";
import { poolStatLines } from "./pool-format.js";
/**
 * Pure state + rendering for the single editable /add panel.
 * No network / Telegram side effects here so it can be unit-tested.
 */
import { InlineKeyboard } from "grammy";
import { fmtNum, fmtUsd, shortAddr } from "../format.js";
import { getStrategy, listStrategies, requireStrategy } from "../strategies/index.js";

/** bins below+above (position width = total+1 incl. active bin) — Meteora max width 1400. */
export const MAX_BINS_PER_POSITION = 1399;
/** ≤ this many bins → single-tx deploy; above → wide multi-tx (extended position). */
export const SINGLE_TX_BINS = 69;

export type BinPresets = { narrow: number; medium: number; wide: number };
export const DEFAULT_BIN_PRESETS: BinPresets = { narrow: 20, medium: 40, wide: 69 };
export const PRESET_IDS = ["narrow", "medium", "wide"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type PanelRange =
  | { kind: "preset"; presetId: PresetId; bins: number }
  /** default: 69 bins (one position tx) — % depends on the pool's bin step */
  | { kind: "def69" }
  | { kind: "bins"; below: number; above: number }
  | { kind: "price"; min: number; max: number }
  /** % from active price: down = −X%, up = +Y% */
  | { kind: "pct"; down: number; up: number; preset?: number };

export const DEFAULT_BINS = 69;
/** % covered by n bins: down = (1 − (1+s)^−n)·100, up = ((1+s)^n − 1)·100, split by side like splitBins. */
export function binsToPct(binStep: number, side: PanelSide, n = DEFAULT_BINS): { down: number; up: number } {
  const r = 1 + binStep / 10_000;
  const { below, above } = splitBins(n, side);
  return { down: (1 - Math.pow(r, -below)) * 100, up: (Math.pow(r, above) - 1) * 100 };
}
const f1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
export function pctShort(r: { down: number; up: number }): string {
  if (r.down > 0 && r.up > 0) return r.down === r.up ? `±${f1(r.down)}%` : `-${f1(r.down)}%/+${f1(r.up)}%`;
  return r.up > 0 ? `+${f1(r.up)}%` : `-${f1(r.down)}%`;
}
/** "Default 69 bin ≈ -50.1%" (needs pool bin step). */
export function defaultRangeLabel(binStep: number, side: PanelSide): string {
  return binStep > 0 ? `Default ${DEFAULT_BINS} bin ≈ ${pctShort(binsToPct(binStep, side))}` : `Default ${DEFAULT_BINS} bin`;
}
/** Preset magnitude → side-aware % (SOL −X, token +X, double ±X). */
export function presetPct(v: number, side: PanelSide): { down: number; up: number } {
  return side === "one_sided_sol" ? { down: v, up: 0 } : side === "one_sided_token" ? { down: 0, up: v } : { down: v, up: v };
}
export function presetPctLabel(v: number, side: PanelSide): string {
  const n = Number.isInteger(v) ? String(v) : String(v);
  return side === "one_sided_sol" ? `-${n}%` : side === "one_sided_token" ? `+${n}%` : `±${n}%`;
}
/** Range button ids: "def" or "p0".."p3". */
export function setRangeChoice(p: AddPanelState, id: string, pcts: number[]): AddPanelState {
  if (id === "def") return { ...p, range: { kind: "def69" } };
  const m = /^p([0-3])$/.exec(id);
  if (!m || pcts[Number(m[1])] == null) throw new Error(`Preset tidak ada: ${id}`);
  const i = Number(m[1]);
  return { ...p, range: { kind: "pct", ...presetPct(pcts[i], p.side), preset: i } };
}

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
  /** token supply (UI units) for MC range */
  supply?: number | null;
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
    range: presets ? { kind: "def69" } : { kind: "def69" },
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
  if (p.range.kind === "def69") {
    ({ below, above } = splitBins(DEFAULT_BINS, p.side));
  } else if (p.range.kind === "preset") {
    ({ below, above } = splitBins(clampBins(p.range.bins), p.side));
  } else if (p.range.kind === "bins") {
    below = p.range.below;
    above = p.range.above;
    if (below + above > MAX_BINS_PER_POSITION)
      error = `Range ${below + above} bins > ${MAX_BINS_PER_POSITION} (batas 1 posisi). Kecilkan bins.`;
  } else if (p.range.kind === "pct") {
    const pr = p.range.preset != null ? presetPct(Math.max(p.range.down, p.range.up), p.side) : sidePct(p.side, p.range);
    ({ below, above } = pctToBins(pr, binStep));
    if (r <= 1) error = "Bin step pool belum diketahui — pilih ulang pool.";
    else if (below + above > MAX_BINS_PER_POSITION) {
      // clamp to the max one position supports, keep the side ratio
      clamped = true;
      const scale = MAX_BINS_PER_POSITION / (below + above);
      const nb = Math.floor(below * scale);
      above = MAX_BINS_PER_POSITION - nb;
      below = nb;
    }
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

/** % → bins (ceil) for a bin step. */
export function pctToBins(pr: { down: number; up: number }, binStep: number): { below: number; above: number } {
  const r = 1 + (binStep > 0 ? binStep / 10_000 : 0);
  if (r <= 1) return { below: 0, above: 0 };
  const below = pr.down > 0 ? Math.ceil(-Math.log(1 - Math.min(99.99, pr.down) / 100) / Math.log(r) - 1e-9) : 0;
  const above = pr.up > 0 ? Math.ceil(Math.log(1 + pr.up / 100) / Math.log(r) - 1e-9) : 0;
  return { below, above };
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

/** Side rules: SOL side → upper fixed 0%; token side → lower fixed 0%; two-sided → both. */
export function sidePct(side: PanelSide, r: { down: number; up: number }): { down: number; up: number } {
  if (side === "one_sided_sol") return { down: r.down || r.up, up: 0 };
  if (side === "one_sided_token") return { down: 0, up: r.up || r.down };
  return { down: r.down, up: r.up };
}

/**
 * Parse a % range.
 *  SOL side:   "50" | "0-50" | "-50"          → −50% .. 0%
 *  Token side: "50" | "0-50" | "+50"          → 0% .. +50%
 *  Two-sided:  "-50 +20" | "-50..+20" | "50 20" → −50% .. +20%  ("30" → ±30%)
 */
export function parsePctRange(text: string, side: PanelSide): { down: number; up: number } | { error: string } {
  const t = text.trim().replace(/%/g, "").replace(/,/g, ".").replace(/\.\.|\/|to|s\/d/gi, " ");
  const m = t.match(/[+-]?\d+(?:\.\d+)?/g);
  if (!m || m.length > 2) return { error: "Format % tidak valid. Contoh: 50, 0-50, -50 +20" };
  // "0-50" style (unsigned a-b) → numbers a and b
  const nums = m.map((x) => ({ v: Math.abs(Number(x)), sign: x.startsWith("+") ? 1 : x.startsWith("-") ? -1 : 0 }));
  const isDash = /^\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*$/.test(t);
  if (isDash) nums[1].sign = 0;
  let down = 0;
  let up = 0;
  if (side !== "two_sided") {
    // one bound fixed at 0%: take the non-zero magnitude ("0-50" → 50)
    const nz = nums.filter((n) => n.v > 0);
    if (nz.length > 1) return { error: side === "one_sided_sol" ? "SOL side: batas atas tetap 0% — isi % turun saja (mis. 50 atau 0-50)." : "Token side: batas bawah tetap 0% — isi % naik saja (mis. 50 atau 0-50)." };
    const v = nz[0]?.v ?? 0;
    if (side === "one_sided_sol") down = v;
    else up = v;
  } else if (nums.length === 1) {
    const n = nums[0];
    if (n.sign < 0) down = n.v;
    else if (n.sign > 0) up = n.v;
    else down = up = n.v;
  } else {
    const [a, b] = nums;
    if (isDash) [down, up] = [a.v, b.v];
    else {
      for (const n of [a, b]) {
        if (n.sign < 0) down = n.v;
        else if (n.sign > 0) up = n.v;
      }
      if (a.sign === 0 && b.sign === 0) [down, up] = [a.v, b.v];
    }
  }
  if (!(down >= 0 && down < 100)) return { error: "% turun harus 0–99.9" };
  if (!(up >= 0 && up <= 10_000)) return { error: "% naik harus 0–10000" };
  if (down + up <= 0) return { error: "Range % tidak boleh 0" };
  return { down, up };
}

export function pctLabel(r: { down: number; up: number }): string {
  return `${r.down ? `−${fmtNum(r.down, 1)}%` : "0%"}..${r.up ? `+${fmtNum(r.up, 1)}%` : "0%"}`;
}

export function parsePriceRange(text: string): { min: number; max: number } | null {
  const parts = text.trim().replace(/,/g, ".").split(/\s+/).map(Number);
  if (parts.length < 2 || !parts.every((x) => Number.isFinite(x) && x > 0) || parts[0] >= parts[1]) return null;
  return { min: parts[0], max: parts[1] };
}

export function rangeLabel(r: PanelRange): string {
  if (r.kind === "def69") return `default ${DEFAULT_BINS} bins`;
  if (r.kind === "preset") return `${r.presetId} (${r.bins} bins)`;
  if (r.kind === "bins") return `custom ${r.below} bawah / ${r.above} atas`;
  if (r.kind === "pct") return r.preset != null ? `preset ${pctLabel(r)}` : `custom ${pctLabel(r)}`;
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
  if (!c.error && c.total > SINGLE_TX_BINS) lines.push(`     🧱 Posisi lebar (>${SINGLE_TX_BINS} bins) → multi-tx, rent posisi lebih besar (kembali saat close)`);
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
  if (sol > 0 && !(p.solUsd && p.solUsd > 0)) return null; // never let unknown price pass the cap as $0
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
  opts: { liqSlippagePct: number; dryRun: boolean; note?: string },
): string {
  const pool = p.pool;
  const strat = getStrategy(p.strategyId);
  const sym = pool ? tokenSymbol(p) : "token";
  const missing = panelMissing(p);
  const bal =
    p.side === "one_sided_sol"
      ? `${fmtNum(p.solBalance ?? 0)} SOL`
      : p.side === "one_sided_token"
        ? `${fmtNum(p.tokenBalance ?? 0)} ${sym}`
        : `${fmtNum(p.solBalance ?? 0)} SOL · ${fmtNum(p.tokenBalance ?? 0)} ${sym}`;
  let rangeLine = `📐 ${rangeLabel(p.range)}`;
  let warn: string | null = null;
  if (pool) {
    const c = computeRange(p, Number(pool.bin_step || 0), p.activePrice);
    const pct = c.downPct > 0 && c.upPct > 0 ? `−${fmtNum(c.downPct, 1)}%/+${fmtNum(c.upPct, 1)}%` : c.upPct > 0 ? `+${fmtNum(c.upPct, 1)}%` : `−${fmtNum(c.downPct, 1)}%`;
    const mcA = marketCap(c.minPrice, p.solUsd ?? null, p.supply ?? null);
    const mcB = marketCap(c.maxPrice, p.solUsd ?? null, p.supply ?? null);
    rangeLine = `📐 ${c.total} bins (${pct})${mcA != null || mcB != null ? ` · MC ${fmtCompactUsd(mcA)}–${fmtCompactUsd(mcB)}` : ""}`;
    if (c.error) warn = `⛔ ${c.error}`;
    else if (c.clamped) warn = `⚠️ Dipotong ke ${MAX_BINS_PER_POSITION} bins`;
  }
  const usd = depositUsd(p);
  const amt = missing.includes("Amount") ? "— (pilih nominal)" : `${amountText(p)}${usd ? ` ($${fmtNum(usd, 2)})` : ""}`;
  return [
    pool ? `🎯 **${sym}** · ${pool.name} · ${poolStatLines(pool)[0]}` : "🎯 Setup — pilih pool dulu",
    pool ? poolStatLines(pool)[1] : null,
    "",
    `💵 ${amt} · ${p.side === "one_sided_sol" ? "SOL side" : p.side === "one_sided_token" ? "Token side" : "Double"} · bal ${bal}`,
    `🧩 ${strat?.label ?? p.strategyId}`,
    rangeLine,
    `⚙️ slip ${opts.liqSlippagePct}% · ${opts.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"}`,
    warn,
    pool && !hasToken(p) ? `💡 Belum pegang ${sym} — Token/Double off` : null,
    opts.note ? `ℹ️ ${opts.note}` : null,
    missing.length ? `👉 Kurang: ${missing.join(", ")}` : "✅ Siap → 👀 Preview",
  ]
    .filter((x) => x !== null)
    .join("\n");
}

const tick = (on: boolean, label: string) => (on ? `✓ ${label}` : label);

export function rangeButtons(kb: InlineKeyboard, p: AddPanelState, pcts: number[]): InlineKeyboard {
  const step = Number(p.pool?.bin_step || 0);
  kb.text(tick(p.range.kind === "def69", defaultRangeLabel(step, p.side)), "ap:set:rng:def").row();
  pcts.slice(0, 4).forEach((v, i) => kb.text(tick(p.range.kind === "pct" && p.range.preset === i, presetPctLabel(v, p.side)), `ap:set:rng:p${i}`));
  return kb.row();
}

export function panelKeyboard(
  p: AddPanelState,
  opts: { binPresets?: BinPresets; amountPresets?: number[]; rangePct?: number[] } = {},
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const st of listStrategies()) kb.text(tick(st.id === p.strategyId, st.label), `ap:set:strat:${st.id}`);
  kb.row();
  kb.text(tick(p.side === "one_sided_sol", "SOL"), "ap:set:mode:one_sided_sol");
  kb.text(tick(p.side === "one_sided_token", "Token"), "ap:set:mode:one_sided_token");
  kb.text(tick(p.side === "two_sided", "Double"), "ap:set:mode:two_sided");
  kb.row();
  rangeButtons(kb, p, opts.rangePct ?? DEFAULT_RANGE_PCT);
  if (p.side === "one_sided_sol") {
    (opts.amountPresets ?? []).slice(0, 3).forEach((a, i) => kb.text(tick(p.amountSol === a && !p.amountPct, `${a}`), `ap:set:amt:${i}`));
  }
  for (const pct of [25, 50, 100]) kb.text(tick(p.amountPct === pct, pct === 100 ? "Max" : `${pct}%`), `ap:set:pct:${pct}`);
  kb.row();
  kb.text("✏️ Range", "ap:edit:range").text("✏️ Nominal", "ap:edit:amount").text("👀 Preview", "ap:deploy").row();
  kb.text("← Pools", "ap:pools").text("🏠 Home", "ap:home");
  return kb;
}

export function rangePickerKeyboard(p: AddPanelState, pcts: number[] = DEFAULT_RANGE_PCT): InlineKeyboard {
  const kb = rangeButtons(new InlineKeyboard(), p, pcts);
  return kb
    .text("✏️ Range %", "ap:set:rng:_pct")
    .row()
    .text("✏️ Bins", "ap:set:rng:_bins")
    .text("✏️ Harga", "ap:set:rng:_price")
    .row()
    .text("✏️ Slippage", "ap:edit:slip")
    .text("⬅️ Panel", "ap:back");
}

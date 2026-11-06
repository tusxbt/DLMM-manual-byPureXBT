import path from "node:path";
import { loadConfig } from "../config.js";
import { readJson, writeJsonAtomic, ensureDir } from "./jsonStore.js";

export type Settings = {
  amountPresets: number[];
  rangePresets: { down: number; up: number }[];
  /** % range presets (quick buttons in /add range picker). SOL side uses down, token side mirrors to up. */
  /** 4 % range preset buttons for /add (magnitude; SOL side = −X%, token side = +X%, double = ±X%). */
  rangePct: number[];
  /** legacy (pre-% UI) — no longer shown */
  binPresets: { narrow: number; medium: number; wide: number };
  /** Skip Confirm/Cancel and execute right after Preview/button (safeguards still enforced). */
  autoConfirm: boolean;
  /** Mix strategy: % of amount deployed as BidAsk (rest Spot), 1–99. */
  mixBidAskPct: number;
  /** PnL card custom background: overlay darkness % and blur px */
  pnlBgDarkPct: number;
  pnlBgBlur: number;
  /** ComputeBudget price for DLMM txs, micro-lamports per CU. 0 = auto (recent fees). */
  priorityFeeMicroLamports: number;
  /** Max priority fee Jupiter may add per swap, in lamports. */
  jupPriorityMaxLamports: number;
  /** Jupiter swap slippage in percent (0.1–50). Converted to bps at quote time. */
  swapSlippagePct: number;
  /** Meteora DLMM add-liquidity slippage in percent (0.1–50). Passed as-is to SDK. */
  liqSlippagePct: number;
  /** Display currency for menus + PnL cards (USD base stored). */
  displayCurrency: "USD" | "IDR" | "SOL";
};

const SLIPPAGE_MIN = 0.1;
const SLIPPAGE_MAX = 50;

function coercePct(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(SLIPPAGE_MAX, Math.max(SLIPPAGE_MIN, Math.round(n * 10) / 10));
}

export function coerceBinPresets(
  v: unknown,
  fallback: { narrow: number; medium: number; wide: number },
): { narrow: number; medium: number; wide: number } {
  const o = (v || {}) as Record<string, unknown>;
  const c = (x: unknown, f: number) => {
    const n = Math.floor(Number(x));
    return Number.isFinite(n) && n >= 1 ? Math.min(1399, n) : f;
  };
  return { narrow: c(o.narrow, fallback.narrow), medium: c(o.medium, fallback.medium), wide: c(o.wide, fallback.wide) };
}

export const DEFAULT_RANGE_PCT = [10, 25, 50, 80];
/** 4 valid % values (0.1–99), else defaults. Old bin-count presets can't map to % without a bin step → reset. */
export function coerceRangePct(v: unknown): number[] {
  if (!Array.isArray(v) || v.length !== 4) return [...DEFAULT_RANGE_PCT];
  const ok = v.map(Number).every((n) => Number.isFinite(n) && n >= 0.1 && n <= 99);
  return ok ? v.map((n) => Math.round(Number(n) * 10) / 10) : [...DEFAULT_RANGE_PCT];
}

export function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (v == null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  return raw ? clampInt(raw, fallback, min, max) : fallback;
}

function envPct(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return coercePct(Number(raw), fallback);
}

function buildDefault(): Settings {
  return {
    amountPresets: [0.5, 1, 2],
    rangePresets: [
      { down: 50, up: 0 },
      { down: 70, up: 0 },
    ],
    binPresets: { narrow: 20, medium: 40, wide: 69 },
    rangePct: [...DEFAULT_RANGE_PCT],
    autoConfirm: false,
    mixBidAskPct: 70,
    pnlBgDarkPct: 60,
    pnlBgBlur: 0,
    priorityFeeMicroLamports: envInt("PRIORITY_FEE_MICROLAMPORTS", 0, 0, 5_000_000),
    jupPriorityMaxLamports: envInt("JUP_PRIORITY_MAX_LAMPORTS", 1_000_000, 0, 10_000_000),
    swapSlippagePct: envPct("SWAP_SLIPPAGE_PCT", 10),
    liqSlippagePct: envPct("LIQ_SLIPPAGE_PCT", 10),
    displayCurrency: "USD",
  };
}

function settingsPath(): string {
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  ensureDir(cfg.dataDir);
  return path.join(cfg.dataDir, "settings.json");
}

export function loadSettings(): Settings {
  const defaults = buildDefault();
  const s = readJson<Partial<Settings> | null>(settingsPath(), null);
  if (!s) {
    writeJsonAtomic(settingsPath(), defaults);
    return structuredClone(defaults);
  }
  return {
    ...structuredClone(defaults),
    ...s,
    binPresets: coerceBinPresets(s.binPresets, defaults.binPresets),
    rangePct: coerceRangePct(s.rangePct),
    autoConfirm: s.autoConfirm === true,
    mixBidAskPct: clampInt(s.mixBidAskPct, 70, 1, 99),
    pnlBgDarkPct: clampInt(s.pnlBgDarkPct, 60, 20, 95),
    pnlBgBlur: clampInt(s.pnlBgBlur, 0, 0, 30),
    rangePresets: Array.isArray(s.rangePresets) ? s.rangePresets.filter((r) => r && Number.isFinite(r.down) && Number.isFinite(r.up)).slice(0, 4) : defaults.rangePresets,
    priorityFeeMicroLamports: clampInt(s.priorityFeeMicroLamports, defaults.priorityFeeMicroLamports, 0, 5_000_000),
    jupPriorityMaxLamports: clampInt(s.jupPriorityMaxLamports, defaults.jupPriorityMaxLamports, 0, 10_000_000),
    swapSlippagePct: coercePct(Number(s.swapSlippagePct ?? defaults.swapSlippagePct), defaults.swapSlippagePct),
    liqSlippagePct: coercePct(Number(s.liqSlippagePct ?? defaults.liqSlippagePct), defaults.liqSlippagePct),
    displayCurrency: (["USD", "IDR", "SOL"].includes(String(s.displayCurrency || "").toUpperCase())
      ? String(s.displayCurrency).toUpperCase()
      : "USD") as Settings["displayCurrency"],
  };
}

export function saveSettings(settings: Settings): void {
  writeJsonAtomic(settingsPath(), settings);
}

import path from "node:path";
import { loadConfig } from "../config.js";
import { readJson, writeJsonAtomic, ensureDir } from "./jsonStore.js";

export type Settings = {
  amountPresets: number[];
  rangePresets: { down: number; up: number }[];
  /** Bin-count range presets for /add (each 1–69). */
  binPresets: { narrow: number; medium: number; wide: number };
  /** Jupiter swap slippage in percent (0.1–50). Converted to bps at quote time. */
  swapSlippagePct: number;
  /** Meteora DLMM add-liquidity slippage in percent (0.1–50). Passed as-is to SDK. */
  liqSlippagePct: number;
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
    return Number.isFinite(n) && n >= 1 ? Math.min(69, n) : f;
  };
  return { narrow: c(o.narrow, fallback.narrow), medium: c(o.medium, fallback.medium), wide: c(o.wide, fallback.wide) };
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
      { down: 30, up: 0 },
      { down: 40, up: 0 },
      { down: 50, up: 0 },
    ],
    binPresets: { narrow: 20, medium: 40, wide: 69 },
    swapSlippagePct: envPct("SWAP_SLIPPAGE_PCT", 10),
    liqSlippagePct: envPct("LIQ_SLIPPAGE_PCT", 10),
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
    swapSlippagePct: coercePct(Number(s.swapSlippagePct ?? defaults.swapSlippagePct), defaults.swapSlippagePct),
    liqSlippagePct: coercePct(Number(s.liqSlippagePct ?? defaults.liqSlippagePct), defaults.liqSlippagePct),
  };
}

export function saveSettings(settings: Settings): void {
  writeJsonAtomic(settingsPath(), settings);
}

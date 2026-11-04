/**
 * Slippage helpers.
 *
 * Meteora @meteora-ag/dlmm 1.9.4: `slippage` on initialize/addLiquidity is a
 * **percentage** 0–100 (see getSlippageMaxAmount: amount * (100+slippage)/100;
 * slippage==100 → U64_MAX). NOT basis points. Old hardcoded `1000` was wrong.
 *
 * Jupiter quote API: `slippageBps` is basis points (10% → 1000).
 */
import { loadSettings, saveSettings, type Settings } from "../store/settings.js";

export const SLIPPAGE_MIN_PCT = 0.1;
export const SLIPPAGE_MAX_PCT = 50;

export function clampSlippagePct(n: number): number {
  if (!Number.isFinite(n)) {
    throw new Error(`Slippage tidak valid: ${n}`);
  }
  if (n < SLIPPAGE_MIN_PCT || n > SLIPPAGE_MAX_PCT) {
    throw new Error(`Slippage harus ${SLIPPAGE_MIN_PCT}–${SLIPPAGE_MAX_PCT}% (dapat: ${n})`);
  }
  return Math.round(n * 10) / 10;
}

export function coerceSlippagePct(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(SLIPPAGE_MAX_PCT, Math.max(SLIPPAGE_MIN_PCT, Math.round(n * 10) / 10));
}

/** Percentage for Meteora SDK (pass-through). */
export function meteoraSlippagePct(pct?: number): number {
  return coerceSlippagePct(pct ?? loadSettings().liqSlippagePct, 10);
}

/** Jupiter bps from percentage (10% → 1000). */
export function jupiterSlippageBps(pct?: number): number {
  const p = coerceSlippagePct(pct ?? loadSettings().swapSlippagePct, 10);
  return Math.round(p * 100);
}

export function getSwapSlippagePct(): number {
  return coerceSlippagePct(loadSettings().swapSlippagePct, 10);
}

export function getLiqSlippagePct(): number {
  return coerceSlippagePct(loadSettings().liqSlippagePct, 10);
}

export function setSwapSlippagePct(pct: number): Settings {
  const s = loadSettings();
  s.swapSlippagePct = clampSlippagePct(pct);
  saveSettings(s);
  return s;
}

export function setLiqSlippagePct(pct: number): Settings {
  const s = loadSettings();
  s.liqSlippagePct = clampSlippagePct(pct);
  saveSettings(s);
  return s;
}

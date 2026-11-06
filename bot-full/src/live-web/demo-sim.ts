import type { LiveSnapshot, LiveBinBar } from "./types.js";

const MIN_BIN = 1000;
const BINS = 41;
const MAX_BIN = MIN_BIN + BINS - 1;

function spotBars(): LiveBinBar[] {
  return Array.from({ length: BINS }, (_, i) => ({
    binId: MIN_BIN + i,
    height: 0.55 + 0.15 * Math.sin(i / 4), // nearly even Spot with slight texture
  })).map((b) => ({ ...b, height: Math.min(1, Math.max(0.35, b.height)) }));
}

/** Deterministic-ish active bin path from wall clock (smooth oscillation + edge visits). */
export function demoActiveFrac(now = Date.now()): number {
  const t = (now / 1000) % 40; // 40s loop
  const u = t / 40;
  let x = 0.5 + 0.28 * Math.sin(u * Math.PI * 2) + 0.07 * Math.sin(u * Math.PI * 6.5);
  if (u > 0.2 && u < 0.26) x = -0.02;
  if (u > 0.7 && u < 0.78) x = 1.03;
  return x;
}

export function buildDemoSnapshot(opts: { currency?: LiveSnapshot["currency"]; now?: number } = {}): LiveSnapshot {
  const now = opts.now ?? Date.now();
  const currency = opts.currency ?? "USD";
  const frac = demoActiveFrac(now);
  const inRange = frac >= 0 && frac <= 1;
  const activeBinId = Math.round(MIN_BIN + Math.max(0, Math.min(1, frac)) * (BINS - 1));
  const minPrice = 0.000312;
  const maxPrice = 0.000498;
  const activePrice = minPrice + Math.max(0, Math.min(1, frac)) * (maxPrice - minPrice);
  // gentle PnL / fees drift for demo
  const wave = Math.sin(now / 8000);
  const pnlUsd = 12.4 + wave * 3.2;
  const feesUsd = 4.85 + Math.abs(wave) * 0.4;
  const capitalUsd = 520;
  const valueUsd = capitalUsd + pnlUsd;

  const fmt = (n: number, sign = false) => {
    if (currency === "IDR") {
      const v = n * 16_200;
      return `${sign ? (n >= 0 ? "+" : "−") : n < 0 ? "−" : ""}Rp${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    }
    if (currency === "SOL") {
      const v = n / 150;
      return `${sign ? (n >= 0 ? "+" : "−") : n < 0 ? "−" : ""}${Math.abs(v).toFixed(4)} SOL`;
    }
    return `${sign ? (n >= 0 ? "+" : "−") : n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
  };

  return {
    demo: true,
    ts: new Date(now).toISOString(),
    pair: "PIRATE/SOL",
    strategy: "Spot",
    positionShort: "DemoPos…preview",
    poolShort: "DemoPool…preview",
    activeBinId,
    activePrice,
    minBinId: MIN_BIN,
    maxBinId: MAX_BIN,
    minPrice,
    maxPrice,
    inRange,
    bins: spotBars(),
    pnlUsd,
    feesUsd,
    capitalUsd,
    valueUsd,
    currency,
    pnlText: fmt(pnlUsd, true),
    feesText: fmt(feesUsd, false),
    valueText: fmt(valueUsd, false),
    capitalText: fmt(capitalUsd, false),
  };
}

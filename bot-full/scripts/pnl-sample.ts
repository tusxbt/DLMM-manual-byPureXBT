import fs from "node:fs";
import { renderPnlCard, preloadPnlBackground } from "../src/render/pnl-card.js";
const t0 = 1_793_000_000;
let p = 0.0000128;
const candles = Array.from({ length: 48 }, (_, i) => {
  const o = p;
  p = Math.max(0.0000105, p * (1 + Math.sin(i / 5) * 0.03 + (i > 30 ? 0.012 : -0.002)));
  return { t: t0 + i * 300, o, c: p, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99 };
});
await preloadPnlBackground();
const loss = process.argv[3] === "loss";
const shape = process.argv[5] || "";
if (shape) {
  // keep price inside the position range so both sides of the bins shape are visible
  const lo = 0.0000112, hi = 0.0000112 * 1.004 ** 68;
  const cs = candles.map((k) => k.c);
  const a = Math.min(...cs), b = Math.max(...cs);
  const end = shape === "bidask" ? 1.02 : shape === "flip" ? -0.02 : shape === "curve" ? 0.5 : 0.55;
  for (const k of candles) {
    const f = (v: number) => lo * 1.1 + ((v - a) / (b - a)) * (hi * 0.93 - lo * 1.1);
    k.o = f(k.o); k.c = f(k.c); k.h = k.c * 1.004; k.l = k.c * 0.996;
  }
  const last = candles[candles.length - 1];
  last.c = lo + (hi - lo) * end;
  p = last.c;
}
// realistic per-bin liquidity (69 bins, step 0.4%): value in SOL terms
const minP = 0.0000112;
const binLiq = shape
  ? Array.from({ length: 69 }, (_, i) => {
      const pr = minP * 1.004 ** i;
      const below = shape === "bidask" ? true : shape === "flip" ? false : pr < p; // one-sided: SOL-only / token-only
      const ref = shape === "bidask" ? minP * 1.004 ** 69 : shape === "flip" ? minP / 1.004 : p;
      const da = Math.abs(Math.log(pr / ref)) / Math.log(1.004 ** 68);
      const w = shape === "bidask" || shape === "flip" ? 0.1 + 1.5 * da : shape === "curve" ? Math.exp(-((da * 3) ** 2)) : 1;
      // Meteora spot: equal token amount per token bin, equal SOL per SOL bin
      const amt = below ? w * 0.05 : w * 4000;
      return { p: pr, x: below ? 0 : amt, y: below ? amt : 0 };
    })
  : null;
const png = renderPnlCard({
  pair: "RAM/SOL", position: "7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg", closed: true,
  depositUsd: 552.12, exitUsd: loss ? 510.82 : 629.02, feesUsd: loss ? 3.12 : 76.45, pnlUsd: loss ? -41.3 : 76.9, pnlPct: loss ? -7.48 : 13.93,
  duration: "4j 12m", minPrice: 0.0000112, maxPrice: shape ? minP * 1.004 ** 68 : 0.0000146, binLiq, exitPrice: p, candles,
  timeLabel: "05 Nov 2026 01:10 KST", source: "Meteora", strategy: process.argv[4] ?? "Mix 70/30", bins: 69, exitLabel: loss ? "MANUAL EXIT" : "ZAPOUT",
});
fs.writeFileSync(process.argv[2] || "sample-pnl.png", png);

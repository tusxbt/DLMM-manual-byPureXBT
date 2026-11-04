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
const png = renderPnlCard({
  pair: "RAM/SOL", position: "7b9f6yDvVthv3BXDL6isBWe8gcrbjBVvXrJz7yKV1tcg", closed: true,
  depositUsd: 552.12, exitUsd: loss ? 510.82 : 629.02, feesUsd: loss ? 3.12 : 76.45, pnlUsd: loss ? -41.3 : 76.9, pnlPct: loss ? -7.48 : 13.93,
  duration: "4j 12m", minPrice: 0.0000112, maxPrice: 0.0000146, exitPrice: p, candles,
  timeLabel: "05 Nov 2026 01:10 KST", source: "Meteora", strategy: "Mix 70/30", bins: 69, exitLabel: loss ? "MANUAL EXIT" : "ZAPOUT",
});
fs.writeFileSync(process.argv[2] || "sample-pnl.png", png);

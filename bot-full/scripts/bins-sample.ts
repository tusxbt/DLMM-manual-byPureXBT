import fs from "node:fs";
import { renderBinsChart } from "../src/render/bins-chart.js";
const out = process.argv[2] || "/workspace/crypto-desk/dlmm";
const mk = (n: number, active: number, step: number, minPrice: number) => {
  const bins = Array.from({ length: n }, (_, i) => {
    // SOL-side BidAsk: more SOL further below; above active (price moved up) bins hold token
    const below = i < active;
    const w = below ? 0.4 + (1 - i / active) * 1.2 : 0;
    const x = !below && i > active - 1 && i < active + 4 ? 9000 * (1 + (i - active) * 0.3) : 0;
    const consumed = below && i > active - 6;
    return { id: 1000 + i, x: consumed ? 0 : x, y: consumed ? 0 : w * 0.01 };
  });
  return { minBin: 1000, maxBin: 1000 + n - 1, activeId: 1000 + active, bins, pxUsd: 0.0004, pyUsd: 97, priceOf: (id: number) => minPrice * (1 + step / 10000) ** (id - 1000) };
};
fs.writeFileSync(`${out}/sample-bins.png`, renderBinsChart({ pair: "Donkey/SOL", symX: "Donkey", symY: "SOL", ...mk(69, 52, 100, 0.0000021) }));
fs.writeFileSync(`${out}/sample-bins-wide.png`, renderBinsChart({ pair: "RAM/SOL", symX: "RAM", symY: "SOL", ...mk(700, 520, 20, 0.0000112) }));

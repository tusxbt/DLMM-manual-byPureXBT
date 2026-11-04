/**
 * Liquidity-by-bin chart (Meteora-style): one bar per bin (downsampled for wide positions),
 * height = USD value in the bin, stacked token X vs quote (SOL) colors, active-bin marker + price,
 * min/max price labels, header "Bins terisi N/M". Same visual family as the PnL card.
 */
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { ensureCardFonts, fmtPx } from "./pnl-card.js";

export type BinsChartData = {
  pair: string;
  minBin: number;
  maxBin: number;
  activeId?: number | null;
  /** per-bin amounts (UI units); missing bins = empty */
  bins: Array<{ id: number; x: number; y: number }>;
  pxUsd?: number | null;
  pyUsd?: number | null;
  /** price of a bin id (quote per token) */
  priceOf: (binId: number) => number | null;
  symX?: string;
  symY?: string;
  maxBars?: number;
};

const BG = "#0b0f14";
const MUTED = "#8a94a8";
const TEXT = "#e8ecf4";
const COL_X = "#a78bfa"; // token side
const COL_Y = "#34d399"; // SOL / quote side
const ACTIVE = "#fbbf24";

const semi = (c: SKRSContext2D, px: number) => (c.font = `${px}px CardSemi, CardSansBold, sans-serif`);
const text = (c: SKRSContext2D, px: number) => (c.font = `${px}px CardText, CardSans, sans-serif`);
const numf = (c: SKRSContext2D, px: number) => (c.font = `${px}px CardNum, CardSansBold, sans-serif`);

export type Bucket = { from: number; to: number; xv: number; yv: number };

/** Sum per-bin values into ≤ maxBars buckets. Values in USD when prices known, else raw amounts. */
export function bucketize(d: BinsChartData): { buckets: Bucket[]; filled: number; total: number; unit: "usd" | "amt" } {
  const total = d.maxBin - d.minBin + 1;
  const usd = d.pxUsd != null && d.pyUsd != null;
  const byId = new Map(d.bins.map((b) => [b.id, b]));
  let filled = 0;
  const n = Math.max(1, Math.min(d.maxBars ?? 70, total));
  const buckets: Bucket[] = [];
  for (let k = 0; k < n; k++) {
    const a = d.minBin + Math.floor((k * total) / n);
    const b = d.minBin + Math.max(Math.floor(((k + 1) * total) / n), Math.floor((k * total) / n) + 1) - 1;
    let xv = 0;
    let yv = 0;
    for (let id = a; id <= b; id++) {
      const bin = byId.get(id);
      if (!bin) continue;
      xv += usd ? bin.x * d.pxUsd! : bin.x;
      yv += usd ? bin.y * d.pyUsd! : bin.y;
    }
    buckets.push({ from: a, to: b, xv, yv });
  }
  for (const b of d.bins) if (b.id >= d.minBin && b.id <= d.maxBin && (b.x > 0 || b.y > 0)) filled++;
  return { buckets, filled, total, unit: usd ? "usd" : "amt" };
}

export function renderBinsChart(d: BinsChartData): Buffer {
  ensureCardFonts();
  const W = 1000;
  const H = 440;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const { buckets, filled, total, unit } = bucketize(d);

  // header
  semi(ctx, 15);
  ctx.fillStyle = MUTED;
  ctx.fillText("DLMM BOSKU · LIKUIDITAS PER BIN", 40, 42);
  numf(ctx, 30);
  ctx.fillStyle = TEXT;
  ctx.fillText(`Bins terisi ${filled}/${total}`, 40, 84);
  // legend
  text(ctx, 14);
  ctx.textAlign = "right";
  const lx = W - 40;
  ctx.fillStyle = MUTED;
  ctx.fillText(`${d.symY ?? "SOL"}`, lx, 84);
  const wY = ctx.measureText(d.symY ?? "SOL").width;
  ctx.fillStyle = COL_Y;
  ctx.fillRect(lx - wY - 18, 74, 10, 10);
  const lx2 = lx - wY - 34;
  ctx.fillStyle = MUTED;
  ctx.fillText(`${d.symX ?? "Token"}`, lx2, 84);
  const wX = ctx.measureText(d.symX ?? "Token").width;
  ctx.fillStyle = COL_X;
  ctx.fillRect(lx2 - wX - 18, 74, 10, 10);
  ctx.textAlign = "left";

  // bars
  const cx = 40;
  const cw = W - 80;
  const top = 120;
  const base = H - 70;
  const ch = base - top;
  const maxV = Math.max(1e-12, ...buckets.map((b) => b.xv + b.yv));
  const slot = cw / buckets.length;
  const gap = slot > 6 ? Math.min(3, slot * 0.2) : 0.5;
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(cx, base, cw, 1);
  buckets.forEach((b, i) => {
    const x = cx + i * slot + gap / 2;
    const w = Math.max(1, slot - gap);
    const hy = ((b.yv / maxV) * ch) | 0;
    const hx = ((b.xv / maxV) * ch) | 0;
    if (b.xv + b.yv <= 0) {
      ctx.fillStyle = "rgba(148,163,184,0.12)";
      ctx.fillRect(x, base - 3, w, 3);
      return;
    }
    ctx.fillStyle = COL_Y;
    ctx.fillRect(x, base - hy, w, hy);
    ctx.fillStyle = COL_X;
    ctx.fillRect(x, base - hy - hx, w, hx);
  });

  // active marker
  if (d.activeId != null) {
    const pos = (d.activeId - d.minBin + 0.5) / total;
    const ax = cx + Math.min(1, Math.max(0, pos)) * cw;
    ctx.strokeStyle = ACTIVE;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(ax, top - 6);
    ctx.lineTo(ax, base + 4);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = `${pos < 0 || pos > 1 ? (pos < 0 ? "◀ " : "") : ""}now ${fmtPx(d.priceOf(d.activeId))}${pos > 1 ? " ▶" : ""}`;
    semi(ctx, 14);
    const tw = ctx.measureText(label).width;
    const lxp = Math.min(W - 40 - tw, Math.max(40, ax - tw / 2));
    ctx.fillStyle = ACTIVE;
    ctx.fillText(label, lxp, top - 12);
  }

  // min / max labels
  text(ctx, 14);
  ctx.fillStyle = MUTED;
  ctx.fillText(`min ${fmtPx(d.priceOf(d.minBin))}`, cx, base + 28);
  ctx.textAlign = "right";
  ctx.fillText(`max ${fmtPx(d.priceOf(d.maxBin))}`, cx + cw, base + 28);
  ctx.textAlign = "center";
  ctx.fillText(`${d.pair} · ${unit === "usd" ? "nilai USD per bin" : "jumlah per bin"}${buckets.length < total ? ` · ${buckets.length} batang` : ""}`, W / 2, base + 28);
  ctx.textAlign = "left";
  ctx.fillStyle = TEXT;
  ctx.textAlign = "right";
  text(ctx, 13);
  ctx.fillStyle = MUTED;
  ctx.fillText("@dlmmbosku_bot", W - 40, H - 14);
  ctx.textAlign = "left";
  return c.toBuffer("image/png");
}

/**
 * PnL card PNG (server-side, @napi-rs/canvas prebuilt — no system deps; DejaVu font bundled).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import type { Candle } from "../engine/ohlcv.js";

const require = createRequire(import.meta.url);
let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  try {
    const dir = path.join(path.dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
    GlobalFonts.registerFromPath(path.join(dir, "DejaVuSans.ttf"), "CardSans");
    GlobalFonts.registerFromPath(path.join(dir, "DejaVuSans-Bold.ttf"), "CardSansBold");
  } catch {
    /* fall back to system fonts */
  }
  fontsReady = true;
}

export type PnlCardData = {
  pair: string;
  position: string;
  closed: boolean;
  depositUsd: number | null;
  exitUsd: number | null; // value + fees (open: current)
  feesUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  duration: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  /** unix seconds */
  entryTime?: number;
  exitTime?: number;
  candles?: Candle[];
  timeLabel: string; // e.g. "04 Nov 2026 23:25 KST"
};

const BG = "#0f1420";
const PANEL = "#171e2e";
const MUTED = "#8a94a8";
const TEXT = "#e8ecf4";
const GREEN = "#22c55e";
const RED = "#ef4444";
const AMBER = "#f59e0b";
const BLUE = "#60a5fa";

const usd = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "n/a" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function fmtPx(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "?";
  if (n >= 1) return Number(n.toPrecision(5)).toString();
  const z = Math.max(0, Math.ceil(-Math.log10(n)) - 1);
  if (z >= 4) return `0.0${String(z).split("").map((d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)]).join("")}${String(Math.round(n * 10 ** (z + 3))).slice(0, 3)}`;
  return Number(n.toPrecision(4)).toString();
}

function font(ctx: SKRSContext2D, px: number, bold = false): void {
  ctx.font = `${px}px ${bold ? "CardSansBold" : "CardSans"}, sans-serif`;
}

export function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const kstHm = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });
const kstDay = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-GB", { timeZone: "Asia/Seoul", day: "2-digit", month: "short" });

function drawChart(ctx: SKRSContext2D, d: PnlCardData, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = "#131722";
  ctx.fillRect(x, y, w, h);
  const candles = d.candles || [];
  if (candles.length < 2) {
    font(ctx, 20);
    ctx.fillStyle = MUTED;
    ctx.fillText("Chart tidak tersedia", x + 24, y + h / 2);
    return;
  }
  const axisR = 110;
  const axisB = 30;
  const px0 = x + 8;
  const pw = w - axisR - 8;
  const py0 = y + 10;
  const ph = h - axisB - 10;

  // y-scale: candles + range + markers, 8% pad; log only if span > 5x
  const vals = candles.flatMap((c) => [c.h, c.l]);
  for (const v of [d.minPrice, d.maxPrice, d.entryPrice, d.exitPrice]) if (v && v > 0) vals.push(v);
  let vmin = Math.min(...vals);
  let vmax = Math.max(...vals);
  if (vmax - vmin < vmax * 1e-6) {
    vmax *= 1.01;
    vmin *= 0.99;
  }
  const useLog = vmax / vmin > 5;
  const f = (v: number) => (useLog ? Math.log(v) : v);
  let lo = f(vmin);
  let hi = f(vmax);
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const Y = (v: number) => py0 + ph - ((f(v) - lo) / (hi - lo)) * ph;

  const n = candles.length;
  const slot = pw / n;
  const t0 = candles[0].t;
  const step = n > 1 ? candles[1].t - candles[0].t : 60;
  const X = (t: number) => px0 + ((t - t0) / step + 0.5) * slot;

  // grid + price axis
  const ticks = useLog
    ? Array.from({ length: 5 }, (_, i) => Math.exp(lo + ((hi - lo) * (i + 0.5)) / 5))
    : niceTicks(useLog ? vmin : lo, hi, 5);
  font(ctx, 14);
  for (const v of ticks) {
    const yy = Y(v);
    if (yy < py0 || yy > py0 + ph) continue;
    ctx.strokeStyle = "#1f2533";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px0, yy);
    ctx.lineTo(px0 + pw, yy);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(fmtPx(v), px0 + pw + 8, yy + 5);
  }
  // time axis (KST)
  const nT = 5;
  const multiDay = candles[n - 1].t - t0 > 36 * 3600;
  for (let i = 0; i < nT; i++) {
    const idx = Math.round((i * (n - 1)) / (nT - 1));
    const t = candles[idx].t;
    const xx = X(t);
    ctx.strokeStyle = "#1f2533";
    ctx.beginPath();
    ctx.moveTo(xx, py0);
    ctx.lineTo(xx, py0 + ph);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.textAlign = i === 0 ? "left" : i === nT - 1 ? "right" : "center";
    ctx.fillText(multiDay ? `${kstDay(t)} ${kstHm(t)}` : kstHm(t), xx, py0 + ph + 20);
  }
  ctx.textAlign = "left";
  ctx.fillText("KST", px0 + pw + 8, py0 + ph + 20);

  // range band
  if (d.minPrice && d.maxPrice) {
    ctx.fillStyle = "rgba(96,165,250,0.08)";
    ctx.fillRect(px0, Y(d.maxPrice), pw, Y(d.minPrice) - Y(d.maxPrice));
    for (const v of [d.maxPrice, d.minPrice]) {
      ctx.strokeStyle = BLUE;
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px0, Y(v));
      ctx.lineTo(px0 + pw, Y(v));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = BLUE;
      ctx.fillRect(px0 + pw + 2, Y(v) - 10, axisR - 4, 20);
      ctx.fillStyle = "#0b1220";
      font(ctx, 13, true);
      ctx.fillText(`${v === d.maxPrice ? "max" : "min"} ${fmtPx(v)}`, px0 + pw + 6, Y(v) + 5);
    }
  }

  // candles
  const bw = Math.max(1, Math.min(18, slot * 0.7));
  for (const c of candles) {
    const cx = Math.round(X(c.t)) + 0.5;
    const flat = c.h === c.l;
    const up = c.c >= c.o;
    const col = flat ? "#4b5563" : up ? "#26a69a" : "#ef5350";
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, Y(c.h));
    ctx.lineTo(cx, Y(c.l));
    ctx.stroke();
    const top = Y(Math.max(c.o, c.c));
    const bot = Y(Math.min(c.o, c.c));
    ctx.fillRect(cx - bw / 2, top, bw, Math.max(1, bot - top));
  }

  // current price line (OPEN)
  const lastC = candles[n - 1].c;
  if (!d.closed) {
    const v = d.exitPrice ?? lastC;
    ctx.strokeStyle = AMBER;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(px0, Y(v));
    ctx.lineTo(px0 + pw, Y(v));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = AMBER;
    ctx.fillRect(px0 + pw + 2, Y(v) - 10, axisR - 4, 20);
    ctx.fillStyle = "#0b1220";
    font(ctx, 13, true);
    ctx.fillText(fmtPx(v), px0 + pw + 6, Y(v) + 5);
  }

  // entry / exit markers at actual timestamps
  const mark = (t: number | undefined, v: number | null | undefined, color: string, label: string, below: boolean) => {
    if (t == null || !v || v <= 0) return;
    const cx = X(Math.min(candles[n - 1].t, Math.max(t0, Math.floor(t / step) * step)));
    const cy = Y(v);
    ctx.fillStyle = color;
    ctx.beginPath();
    if (below) {
      ctx.moveTo(cx, cy + 6);
      ctx.lineTo(cx - 7, cy + 18);
      ctx.lineTo(cx + 7, cy + 18);
    } else {
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx - 7, cy - 18);
      ctx.lineTo(cx + 7, cy - 18);
    }
    ctx.closePath();
    ctx.fill();
    font(ctx, 14, true);
    const tw = ctx.measureText(label).width;
    const right = cx > px0 + pw - tw - 20;
    const lx = right ? cx - 10 - tw : cx + 10;
    const ly = below ? cy + 34 : cy - 24;
    ctx.fillStyle = "rgba(19,23,34,0.85)";
    ctx.fillRect(lx - 4, ly - 15, tw + 8, 20);
    ctx.fillStyle = color;
    ctx.fillText(label, lx, ly);
  };
  mark(d.entryTime, d.entryPrice, AMBER, `entry ${fmtPx(d.entryPrice)}`, true);
  if (d.closed) mark(d.exitTime, d.exitPrice ?? lastC, TEXT, `exit ${fmtPx(d.exitPrice ?? lastC)}`, false);
}

export function renderPnlCard(d: PnlCardData): Buffer {
  ensureFonts();
  const W = 1200;
  const H = 680;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const pnlColor = d.pnlUsd == null ? MUTED : d.pnlUsd >= 0 ? GREEN : RED;
  font(ctx, 40, true);
  ctx.fillStyle = TEXT;
  ctx.fillText(d.pair, 40, 64);
  font(ctx, 20);
  ctx.fillStyle = MUTED;
  ctx.fillText(`Meteora DLMM · ${d.closed ? "CLOSED" : "OPEN"} · ${d.position.slice(0, 4)}…${d.position.slice(-4)}`, 40, 96);
  ctx.textAlign = "right";
  ctx.fillText(d.timeLabel, W - 40, 64);
  ctx.textAlign = "left";

  // big PnL
  font(ctx, 64, true);
  ctx.fillStyle = pnlColor;
  const pnlTxt = d.pnlUsd == null ? "PnL n/a" : `${d.pnlUsd >= 0 ? "+" : "-"}$${Math.abs(d.pnlUsd).toFixed(2)}`;
  ctx.fillText(pnlTxt, 40, 176);
  if (d.pnlPct != null) {
    font(ctx, 32, true);
    ctx.fillText(`${d.pnlPct >= 0 ? "+" : ""}${d.pnlPct.toFixed(2)}%`, 40, 220);
  }

  // stats column
  const stats: Array<[string, string]> = [
    ["Deposit", usd(d.depositUsd)],
    [d.closed ? "Exit (incl. fee)" : "Value + fee", usd(d.exitUsd)],
    ["Fee earned", usd(d.feesUsd)],
    ["Durasi", d.duration ?? "n/a"],
    ["Range", d.minPrice && d.maxPrice ? `${fmtPx(d.minPrice)} – ${fmtPx(d.maxPrice)}` : "n/a"],
  ];
  let sy = 112;
  for (const [k, v] of stats) {
    font(ctx, 18);
    ctx.fillStyle = MUTED;
    ctx.fillText(k, 520, sy);
    font(ctx, 22, true);
    ctx.fillStyle = TEXT;
    ctx.textAlign = "right";
    ctx.fillText(v, W - 40, sy);
    ctx.textAlign = "left";
    sy += 31;
  }

  drawChart(ctx, d, 40, 280, W - 80, 365);
  font(ctx, 14);
  ctx.fillStyle = MUTED;
  ctx.fillText("Harga: SOL per token · candle: GeckoTerminal · waktu: KST", 40, H - 14);
  return c.toBuffer("image/png");
}

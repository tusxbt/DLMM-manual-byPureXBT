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

function drawChart(ctx: SKRSContext2D, d: PnlCardData, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, w, h);
  const candles = d.candles || [];
  if (candles.length < 2) {
    font(ctx, 20);
    ctx.fillStyle = MUTED;
    ctx.fillText("Chart tidak tersedia", x + 24, y + h / 2);
    return;
  }
  const vals = candles.flatMap((c) => [c.h, c.l]);
  for (const v of [d.minPrice, d.maxPrice, d.entryPrice, d.exitPrice]) if (v && v > 0) vals.push(v);
  // log scale (DLMM bins are geometric)
  let lo = Math.log(Math.min(...vals));
  let hi = Math.log(Math.max(...vals));
  if (hi - lo < 1e-9) {
    hi += 0.01;
    lo -= 0.01;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const padL = 16;
  const padR = 120;
  const cw = w - padL - padR;
  const Y = (v: number) => y + h - 14 - ((Math.log(v) - lo) / (hi - lo)) * (h - 28);
  const step = cw / candles.length;
  const t0 = candles[0].t;
  const t1 = candles[candles.length - 1].t;
  const X = (t: number) => x + padL + ((t - t0) / Math.max(1, t1 - t0)) * (cw - step) + step / 2;

  // range band
  if (d.minPrice && d.maxPrice) {
    ctx.fillStyle = "rgba(96,165,250,0.10)";
    ctx.fillRect(x + padL, Y(d.maxPrice), cw, Y(d.minPrice) - Y(d.maxPrice));
    for (const [v, label] of [
      [d.maxPrice, "max"],
      [d.minPrice, "min"],
    ] as const) {
      ctx.strokeStyle = BLUE;
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + padL, Y(v));
      ctx.lineTo(x + padL + cw, Y(v));
      ctx.stroke();
      ctx.setLineDash([]);
      font(ctx, 16);
      ctx.fillStyle = BLUE;
      ctx.fillText(`${label} ${fmtPx(v)}`, x + padL + cw + 8, Y(v) + 6);
    }
  }
  // candles
  const bw = Math.max(2, Math.min(14, step * 0.65));
  for (const c of candles) {
    const cx = X(c.t);
    const up = c.c >= c.o;
    ctx.strokeStyle = ctx.fillStyle = up ? GREEN : RED;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, Y(c.h));
    ctx.lineTo(cx, Y(c.l));
    ctx.stroke();
    const top = Y(Math.max(c.o, c.c));
    ctx.fillRect(cx - bw / 2, top, bw, Math.max(1.5, Y(Math.min(c.o, c.c)) - top));
  }
  // entry/exit markers
  const mark = (t: number, v: number | null | undefined, color: string, label: string) => {
    if (!v || v <= 0) return;
    const cx = X(Math.min(t1, Math.max(t0, t)));
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, Y(v), 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = BG;
    ctx.lineWidth = 2;
    ctx.stroke();
    font(ctx, 16, true);
    ctx.fillText(label, Math.min(cx + 12, x + padL + cw - 60), Y(v) - 12);
  };
  mark(t0, d.entryPrice ?? candles[0].o, AMBER, "entry");
  mark(t1, d.exitPrice ?? candles[candles.length - 1].c, d.closed ? TEXT : AMBER, d.closed ? "exit" : "now");
}

export function renderPnlCard(d: PnlCardData): Buffer {
  ensureFonts();
  const W = 1200;
  const H = 675;
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
  let sy = 140;
  for (const [k, v] of stats) {
    font(ctx, 18);
    ctx.fillStyle = MUTED;
    ctx.fillText(k, 520, sy);
    font(ctx, 22, true);
    ctx.fillStyle = TEXT;
    ctx.textAlign = "right";
    ctx.fillText(v, W - 40, sy);
    ctx.textAlign = "left";
    sy += 34;
  }

  drawChart(ctx, d, 40, 320, W - 80, 315);
  font(ctx, 14);
  ctx.fillStyle = MUTED;
  ctx.fillText("Harga dalam SOL per token · data: GeckoTerminal", 40, H - 14);
  return c.toBuffer("image/png");
}

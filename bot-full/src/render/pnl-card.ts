/**
 * PnL card PNG (server-side, @napi-rs/canvas prebuilt — no system deps; DejaVu font bundled).
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, Image, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
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
  /** "Meteora" (datapi, same as UI) or "estimasi" (own calc) */
  source?: string;
  /** footer fields */
  strategy?: string | null;
  modal?: string | null;
  bins?: number | null;
  /** top-right pill, e.g. "MANUAL EXIT" / "ZAPOUT" */
  exitLabel?: string | null;
  /** custom background image path (default assets/pnl-bg.jpg or PNL_BG_PATH) */
  background?: string | null;
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

const ACCENT = "#2dd4bf";
const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets");
const bgCache = new Map<string, Image | null>();
const bgFile = (p?: string | null) => p || process.env.PNL_BG_PATH || path.join(ASSETS, "pnl-bg.jpg");
/** Decode background (async in napi-rs) — call before renderPnlCard. Never throws. */
export async function preloadPnlBackground(p?: string | null): Promise<void> {
  const f = bgFile(p);
  if (bgCache.has(f)) return;
  try {
    bgCache.set(f, fs.existsSync(f) ? await loadImage(f) : null);
  } catch {
    bgCache.set(f, null);
  }
}
function loadBg(p?: string | null): Image | null {
  return bgCache.get(bgFile(p)) ?? null;
}

let thinReady = false;
function ensureThin(): void {
  if (thinReady) return;
  try {
    GlobalFonts.registerFromPath(path.join(ASSETS, "fonts", "Oxanium.ttf"), "CardThin");
  } catch {
    /* DejaVu fallback */
  }
  thinReady = true;
}
const thin = (ctx: SKRSContext2D, px: number) => (ctx.font = `${px}px CardThin, CardSans, sans-serif`);

function rr(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pill(ctx: SKRSContext2D, text: string, xRight: number, y: number, color: string, px = 14): void {
  thin(ctx, px);
  const tw = ctx.measureText(text).width;
  const w = tw + px * 1.6;
  const h = px * 1.9;
  rr(ctx, xRight - w, y, w, h, h / 2);
  ctx.fillStyle = "rgba(10,14,22,0.55)";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.fillText(text, xRight - w / 2, y + h * 0.68);
  ctx.textAlign = "left";
}

/** Mini candle chart in a translucent panel (logical 1024x576 coords). */
function drawPanelChart(ctx: SKRSContext2D, d: PnlCardData, x: number, y: number, w: number, h: number): void {
  rr(ctx, x, y, w, h, 16);
  ctx.fillStyle = "rgba(14,18,28,0.62)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();
  thin(ctx, 13);
  ctx.fillStyle = MUTED;
  ctx.fillText("HARGA (SOL)", x + 20, y + 28);
  const candles = d.candles || [];
  const last = candles.length ? candles[candles.length - 1].c : null;
  const px = d.exitPrice ?? last;
  const inRange = px != null && d.minPrice != null && d.maxPrice != null ? px >= d.minPrice && px <= d.maxPrice : null;
  if (inRange != null) pill(ctx, inRange ? "IN RANGE" : "OUT OF RANGE", x + w - 20, y + 12, inRange ? GREEN : RED, 12);

  const cx = x + 20, cw = w - 40, cy = y + 56, ch = h - 100;
  if (candles.length < 2) {
    thin(ctx, 15);
    ctx.fillStyle = MUTED;
    ctx.fillText("Chart tidak tersedia", cx, cy + ch / 2);
  } else {
    const vals = candles.flatMap((c) => [c.h, c.l]);
    for (const v of [d.minPrice, d.maxPrice]) if (v && v > 0) vals.push(v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < hi * 1e-6) { hi *= 1.01; lo *= 0.99; }
    const useLog = hi / lo > 5;
    const f = (v: number) => (useLog ? Math.log(v) : v);
    const pad = (f(hi) - f(lo)) * 0.08;
    const L = f(lo) - pad, Hh = f(hi) + pad;
    const Y = (v: number) => cy + ch - ((f(v) - L) / (Hh - L)) * ch;
    // range band
    if (d.minPrice && d.maxPrice) {
      const y1 = Y(d.maxPrice), y2 = Y(d.minPrice);
      ctx.fillStyle = "rgba(129,140,248,0.16)";
      ctx.fillRect(cx, y1, cw - 30, Math.max(2, y2 - y1));
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = "rgba(165,180,252,0.85)";
      ctx.lineWidth = 1.2;
      for (const yy of [y1, y2]) { ctx.beginPath(); ctx.moveTo(cx, yy); ctx.lineTo(cx + cw - 30, yy); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    const n = candles.length;
    const slot = (cw - 30) / n;
    const bw = Math.max(1.5, Math.min(12, slot * 0.62));
    candles.forEach((c, i) => {
      const mx = cx + (i + 0.5) * slot;
      const col = c.c >= c.o ? "#2bd99f" : "#f2546b";
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(mx, Y(c.h)); ctx.lineTo(mx, Y(c.l)); ctx.stroke();
      const top = Y(Math.max(c.o, c.c)), bot = Y(Math.min(c.o, c.c));
      ctx.fillStyle = col;
      ctx.fillRect(mx - bw / 2, top, bw, Math.max(1.5, bot - top));
    });
    if (d.closed) {
      const ex = cx + (n - 0.5) * slot + 6;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.beginPath(); ctx.moveTo(ex, cy - 4); ctx.lineTo(ex, cy + ch); ctx.stroke();
      ctx.setLineDash([]);
      pill(ctx, "EXIT", Math.min(x + w - 20, ex + 22), y + 42, "rgba(230,235,245,0.9)", 12);
    }
    thin(ctx, 12);
    ctx.fillStyle = MUTED;
    ctx.fillText(`HIGH ${fmtPx(Math.max(...candles.map((c) => c.h)))}`, x + 20, y + h - 18);
    ctx.textAlign = "right";
    ctx.fillText(`LOW ${fmtPx(Math.min(...candles.map((c) => c.l)))}`, x + w - 20, y + h - 18);
    ctx.textAlign = "left";
  }
}

const money = (n: number | null | undefined, sign = false) =>
  n == null || !Number.isFinite(n)
    ? "n/a"
    : `${sign ? (n >= 0 ? "+" : "-") : n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function renderPnlCard(d: PnlCardData): Buffer {
  ensureFonts();
  ensureThin();
  const S = 1.25; // 1280x720 output, logical 1024x576
  const W = 1024, H = 576;
  const c = createCanvas(W * S, H * S);
  const ctx = c.getContext("2d");
  ctx.scale(S, S);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const bg = loadBg(d.background);
  if (bg) {
    const k = Math.max(W / bg.width, H / bg.height);
    const iw = bg.width * k, ih = bg.height * k;
    // blur hides baked-in text of screenshot-style backgrounds; set PNL_BG_BLUR=0 for clean art
    const blur = Number(process.env.PNL_BG_BLUR ?? 9);
    if (blur > 0) ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(bg, (W - iw) / 2 - 20, (H - ih) / 2 - 20, iw + 40, ih + 40);
    ctx.filter = "none";
  }
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "rgba(6,9,15,0.72)");
  grad.addColorStop(0.55, "rgba(6,9,15,0.45)");
  grad.addColorStop(1, "rgba(6,9,15,0.55)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // header
  thin(ctx, 22);
  ctx.fillStyle = TEXT;
  ctx.fillText("PENGOCOK LP — DLMM", 56, 58);
  thin(ctx, 14);
  ctx.fillStyle = ACCENT;
  ctx.fillText("manual liquidity · meteora", 56, 80);
  ctx.fillRect(56, 93, 64, 3);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(120, 94, 300, 1);
  pill(ctx, d.exitLabel || (d.closed ? "MANUAL EXIT" : "OPEN"), W - 40, 40, "rgba(230,235,245,0.9)", 14);

  // left
  const pnlColor = d.pnlUsd == null ? MUTED : d.pnlUsd >= 0 ? ACCENT : RED;
  const label = (t: string, y: number) => { thin(ctx, 13); ctx.fillStyle = MUTED; ctx.fillText(t, 56, y); };
  label("DURASI", 150);
  thin(ctx, 28); ctx.fillStyle = TEXT; ctx.fillText((d.duration ?? "n/a").toUpperCase(), 56, 186);
  label("PAIR", 232);
  thin(ctx, 42); ctx.fillStyle = TEXT; ctx.fillText(d.pair.replace("/", "-").slice(0, 16), 56, 276);
  label(`PROFIT (USD)${d.source && d.source !== "Meteora" ? " · estimasi" : ""}`, 324);
  thin(ctx, 64); ctx.fillStyle = pnlColor; ctx.fillText(money(d.pnlUsd, true), 56, 392);

  drawPanelChart(ctx, d, 560, 128, 416, 256);

  // footer
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.fillRect(56, 465, W - 112, 1);
  const pct = d.pnlPct == null ? "n/a" : `${d.pnlPct >= 0 ? "+" : ""}${d.pnlPct.toFixed(2)}%`;
  const cols: Array<[string, string, string]> = [
    ["STRATEGI", d.strategy || "n/a", TEXT],
    ["MODAL", d.modal || money(d.depositUsd), TEXT],
    ["BINS", d.bins != null ? String(d.bins) : "n/a", TEXT],
    ["FEES", money(d.feesUsd), d.feesUsd != null && d.feesUsd > 0 ? ACCENT : TEXT],
    [d.closed ? "NILAI EXIT" : "NILAI", money(d.exitUsd), TEXT],
    ["PNL", pct, d.pnlPct == null ? MUTED : d.pnlPct >= 0 ? ACCENT : RED],
  ];
  const colW = (W - 112) / cols.length;
  cols.forEach(([k, v, col], i) => {
    const x = 56 + i * colW;
    thin(ctx, 12); ctx.fillStyle = MUTED; ctx.fillText(k, x, 494);
    let px = 22;
    thin(ctx, px);
    while (ctx.measureText(v).width > colW - 10 && px > 12) thin(ctx, --px);
    ctx.fillStyle = col; ctx.fillText(v, x, 524);
  });
  thin(ctx, 12);
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.fillText(d.timeLabel, W - 56, 556);
  ctx.textAlign = "left";
  return c.toBuffer("image/png");
}

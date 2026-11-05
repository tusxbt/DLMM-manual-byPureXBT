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
  /** real per-bin liquidity (price, X value, Y value — same units); null → idealised shape */
  /** which side holds liquidity, for the idealised fallback shape */
  side?: "sol" | "token" | "both" | null;
  modal?: string | null;
  bins?: number | null;
  /** top-right pill, e.g. "MANUAL EXIT" / "ZAPOUT" */
  exitLabel?: string | null;
  /** custom background image path (default assets/pnl-bg.jpg or PNL_BG_PATH) */
  background?: string | null;
  /** overlay darkness 20–95 % (default 70) */
  bgDarkPct?: number | null;
  /** background blur px (default PNL_BG_BLUR or 0) */
  bgBlur?: number | null;
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

/** Short vertical tag for the chart side: SPOT / CURVE / BIDASK / MIX 70/30; unknown → MANUAL. */
export function strategyTag(s: string | null | undefined): string {
  const t = String(s ?? "").trim();
  if (!t) return "MANUAL";
  if (/bid.?ask/i.test(t)) return "BIDASK";
  if (/spot/i.test(t)) return "SPOT";
  if (/curve/i.test(t)) return "CURVE";
  if (/mix/i.test(t)) return t.toUpperCase().replace(/\s+/g, " ");
  return t.toUpperCase().slice(0, 12);
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

const ACCENT = "#a78bfa"; // brand violet
const UP = "#34d399";
const DOWN = "#fb7185";
const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets");
const bgCache = new Map<string, Image | null>();
const bgFile = (p?: string | null) => p || process.env.PNL_BG_PATH || "";
const bgKey = (f: string) => {
  try {
    return `${f}@${fs.statSync(f).mtimeMs}`;
  } catch {
    return `${f}@none`;
  }
};
/** Decode background (async in napi-rs) — call before renderPnlCard. Never throws. Cache keyed by mtime. */
export async function preloadPnlBackground(p?: string | null): Promise<void> {
  const f = bgFile(p);
  if (!f) return;
  const k = bgKey(f);
  if (bgCache.has(k)) return;
  try {
    bgCache.set(k, fs.existsSync(f) ? await loadImage(f) : null);
  } catch {
    bgCache.set(k, null);
  }
}
function loadBg(p?: string | null): Image | null {
  const f = bgFile(p);
  return f ? (bgCache.get(bgKey(f)) ?? null) : null;
}

let thinReady = false;
function ensureThin(): void {
  if (thinReady) return;
  try {
    GlobalFonts.registerFromPath(path.join(ASSETS, "fonts", "Manrope-Regular.ttf"), "CardText");
    GlobalFonts.registerFromPath(path.join(ASSETS, "fonts", "Manrope-SemiBold.ttf"), "CardSemi");
    GlobalFonts.registerFromPath(path.join(ASSETS, "fonts", "SpaceGrotesk-Bold.ttf"), "CardNum");
  } catch {
    /* DejaVu fallback */
  }
  thinReady = true;
}
const thin = (ctx: SKRSContext2D, px: number) => (ctx.font = `${px}px CardText, CardSans, sans-serif`);
const semi = (ctx: SKRSContext2D, px: number) => (ctx.font = `${px}px CardSemi, CardSansBold, sans-serif`);
const numf = (ctx: SKRSContext2D, px: number) => (ctx.font = `${px}px CardNum, CardSansBold, sans-serif`);

const money = (n: number | null | undefined, sign = false) =>
  n == null || !Number.isFinite(n)
    ? "n/a"
    : `${sign ? (n >= 0 ? "+" : "-") : n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Up: hollow light body; Down: filled dark gray. Thin gray wicks. No green/red — matches B&W manga card BGs. */
export const CANDLE_UP = "#e8e8e8";
export const CANDLE_DOWN = "#3a3a3a";
export const CANDLE_WICK = "rgba(180,180,180,0.55)";
export const CANDLE_OUTLINE = "rgba(220,220,220,0.55)";
export function drawCandles(
  ctx: SKRSContext2D,
  candles: Array<{ o: number; h: number; l: number; c: number }>,
  cx: number, cw: number, cy: number, ch: number,
  Y: (v: number) => number,
  X: (i: number) => number,
): void {
  // very subtle gray grid
  ctx.save();
  ctx.strokeStyle = "rgba(160,160,160,0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = cy + (ch * i) / 4;
    ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + cw, y); ctx.stroke();
  }
  ctx.restore();
  const n = candles.length;
  const slot = n > 1 ? cw / (n - 1) : cw;
  const bodyW = Math.max(2, Math.min(10, slot * 0.55));
  candles.forEach((k, i) => {
    const x = X(i);
    const up = k.c >= k.o;
    const yO = Y(k.o), yC = Y(k.c), yH = Y(k.h), yL = Y(k.l);
    // thin gray wick
    ctx.strokeStyle = CANDLE_WICK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yH);
    ctx.lineTo(x, yL);
    ctx.stroke();
    // body: up = hollow light, down = filled dark
    const top = Math.min(yO, yC), bot = Math.max(yO, yC);
    const h = Math.max(1.5, bot - top);
    const bx = x - bodyW / 2;
    if (up) {
      ctx.fillStyle = "rgba(232,232,232,0.18)";
      ctx.fillRect(bx, top, bodyW, h);
      ctx.strokeStyle = CANDLE_UP;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(bx + 0.5, top + 0.5, bodyW - 1, h - 1);
    } else {
      ctx.fillStyle = CANDLE_DOWN;
      ctx.fillRect(bx, top, bodyW, h);
      ctx.strokeStyle = CANDLE_OUTLINE;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, top + 0.5, bodyW - 1, h - 1);
    }
  });
}

export function renderPnlCard(d: PnlCardData): Buffer {
  ensureFonts();
  ensureThin();
  const W = 1200, H = 800;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const up = d.pnlUsd == null || d.pnlUsd >= 0;
  const col = d.pnlUsd == null ? MUTED : up ? UP : DOWN;
  const rgb = up ? "52,211,153" : "251,113,133";

  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, W, H);
  const bg = loadBg(d.background);
  if (bg) {
    const k = Math.max(W / bg.width, H / bg.height);
    const blur = Math.max(0, Math.min(30, d.bgBlur ?? Number(process.env.PNL_BG_BLUR ?? 0)));
    if (blur > 0) ctx.filter = `blur(${blur}px)`;
    const m = blur * 2; // bleed so blurred edges stay filled
    ctx.drawImage(bg, (W - bg.width * k) / 2 - m, (H - bg.height * k) / 2 - m, bg.width * k + 2 * m, bg.height * k + 2 * m);
    ctx.filter = "none";
    const dark = Math.max(20, Math.min(95, d.bgDarkPct ?? 70)) / 100; // never fully bright: text must stay readable
    ctx.fillStyle = `rgba(11,15,20,${dark})`;
    ctx.fillRect(0, 0, W, H);
  }
  // one soft accent: glow behind the number
  const g = ctx.createRadialGradient(W / 2, 250, 0, W / 2, 250, 420);
  g.addColorStop(0, `rgba(${rgb},0.13)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const center = (t: string, y: number, px: number, color: string, f: (c: SKRSContext2D, px: number) => unknown = thin) => {
    f(ctx, px);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(t, W / 2, y);
    ctx.textAlign = "left";
  };
  // brand + pair line
  center("TUSVICIOUS", 78, 16, MUTED, semi);
  const pairLine = [d.pair.replace("-", "/"), d.strategy].filter(Boolean).join("  ·  ");
  center(pairLine, 128, 28, TEXT, semi);

  // big PnL %
  const pct = d.pnlPct == null ? "n/a" : `${d.pnlPct >= 0 ? "+" : "−"}${Math.abs(d.pnlPct).toFixed(2)}%`;
  center(pct, 270, 112, col, numf);
  center(money(d.pnlUsd, true), 330, 36, col, numf);
  center(d.source === "Meteora" ? "PnL · Meteora" : d.source === "realized" ? "PnL realized · tanpa rent & fee tx" : "PnL estimasi", 368, 16, MUTED);

  // full-width minimal area chart
  const cx = 70, cw = W - 160, cy = 410, ch = 170;
  const candles = d.candles || [];
  if (candles.length >= 2) {
    const closes = candles.map((k) => k.c);
    const vals = [...closes, ...candles.map((k) => k.h), ...candles.map((k) => k.l)];
    for (const v of [d.minPrice, d.maxPrice, d.entryPrice, d.exitPrice]) if (v && v > 0) vals.push(v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < hi * 1e-6) { hi *= 1.01; lo *= 0.99; }
    const useLog = hi / lo > 5;
    const f = (v: number) => (useLog ? Math.log(v) : v);
    const pad = (f(hi) - f(lo)) * 0.1;
    const L = f(lo) - pad, Hh = f(hi) + pad;
    const Y = (v: number) => cy + ch - ((f(v) - L) / (Hh - L)) * ch;
    const X = (i: number) => cx + (i / (closes.length - 1)) * cw;
    if (d.minPrice && d.maxPrice) {
      const y1 = Y(d.maxPrice), y2 = Y(d.minPrice);
      ctx.fillStyle = "rgba(148,163,184,0.06)";
      ctx.fillRect(cx, y1, cw, Math.max(2, y2 - y1));
      // max / min bin price lines
      for (const [y, lbl, below] of [[y1, `max bin ${fmtPx(d.maxPrice)}`, false], [y2, `min bin ${fmtPx(d.minPrice)}`, true]] as const) {
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = "rgba(148,163,184,0.55)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.lineTo(cx + cw, y);
        ctx.stroke();
        ctx.restore();
        thin(ctx, 13);
        ctx.fillStyle = "rgba(203,213,225,0.8)";
        ctx.textAlign = "right";
        ctx.fillText(lbl, cx + cw - 4, below ? y + 16 : y - 7);
        ctx.textAlign = "left";
      }
    }
    // dark-mode candlesticks — real OHLC from GeckoTerminal (never synthesized from closes alone)
    drawCandles(ctx, candles, cx, cw, cy, ch, Y, X);
    // vertical strategy tag on the right of the chart
    {
      const tag = strategyTag(d.strategy);
      thin(ctx, 12);
      ctx.save();
      ctx.fillStyle = "rgba(148,163,184,0.7)";
      ctx.translate(cx + cw + 18, cy + ch / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(tag, 0, 0);
      ctx.restore();
    }
    const dot = (x: number, y: number, fill: string, label: string, right: boolean) => {
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = "#0b0f14"; ctx.stroke();
      thin(ctx, 12); ctx.fillStyle = MUTED; ctx.textAlign = right ? "right" : "left";
      ctx.fillText(label, x + (right ? -10 : 10), y - 9); ctx.textAlign = "left";
    };
    // entry/exit aligned to the candle whose time covers the timestamp (fallback: edges)
    const idxAt = (sec?: number) => {
      if (sec == null || !candles.length) return 0;
      let best = 0;
      for (let i = 0; i < candles.length; i++) if (candles[i].t <= sec) best = i;
      return best;
    };
    const ei = d.entryTime != null ? idxAt(d.entryTime) : 0;
    const xi = d.closed ? (d.exitTime != null ? idxAt(d.exitTime) : candles.length - 1) : -1;
    dot(X(ei), Y(d.entryPrice ?? candles[ei].c), TEXT, "entry", false);
    if (xi >= 0) dot(X(xi), Y(d.exitPrice ?? candles[xi].c), col, "exit", true);
  } else {
    center("chart tidak tersedia", cy + ch / 2, 16, MUTED);
  }

  // stats: single row of 6
  const stats: Array<[string, string, string]> = [
    ["Modal", d.modal || money(d.depositUsd), TEXT],
    [d.closed ? "Exit" : "Nilai", money(d.exitUsd), TEXT],
    ["Fees", money(d.feesUsd), d.feesUsd != null && d.feesUsd > 0 ? UP : TEXT],
    ["Durasi", d.duration ?? "n/a", TEXT],
    ["Bins", d.bins != null ? String(d.bins) : "n/a", TEXT],
  ];
  const sw = (W - 140) / stats.length;
  stats.forEach(([k, v, cl], i) => {
    const x = 70 + sw * i + sw / 2;
    ctx.textAlign = "center";
    semi(ctx, 12); ctx.fillStyle = MUTED; ctx.fillText(k.toUpperCase(), x, 652);
    let fpx = 24; semi(ctx, fpx);
    while (ctx.measureText(v).width > sw - 12 && fpx > 14) semi(ctx, --fpx);
    ctx.fillStyle = cl; ctx.fillText(v, x, 688);
  });
  ctx.textAlign = "left";

  // footer
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(70, 730, W - 140, 1);
  thin(ctx, 14);
  ctx.fillStyle = MUTED;
  ctx.fillText(`${d.exitLabel ? d.exitLabel.toLowerCase() + " · " : ""}${d.timeLabel}`, 70, 764);
  ctx.textAlign = "right";
  ctx.fillStyle = TEXT;
  ctx.fillText("@dlmmbosku_bot", W - 70, 764);
  ctx.textAlign = "left";
  return c.toBuffer("image/png");
}

/** Register bundled card fonts (Manrope / Space Grotesk) for other renderers. */
export function ensureCardFonts(): void {
  ensureFonts();
  ensureThin();
}

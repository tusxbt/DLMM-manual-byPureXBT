/**
 * PnL card PNG (server-side, @napi-rs/canvas prebuilt — no system deps; DejaVu font bundled).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import type { Candle } from "../engine/ohlcv.js";
import { paintCardBackground, preloadPnlBackground } from "./card-bg.js";
import { activeDisplay, fmtMoney } from "../display-money.js";
export { preloadPnlBackground } from "./card-bg.js";

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

const usd = (n: number | null | undefined) => fmtMoney(n, { ...activeDisplay(), na: "n/a" });

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

const money = (n: number | null | undefined, sign = false) => fmtMoney(n, { sign, ...activeDisplay(), na: "n/a" });

export function renderPnlCard(d: PnlCardData): Buffer {
  ensureFonts();
  ensureThin();
  const W = 1200, H = 800;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const up = d.pnlUsd == null || d.pnlUsd >= 0;
  const col = d.pnlUsd == null ? MUTED : up ? UP : DOWN;
  const rgb = up ? "52,211,153" : "251,113,133";

  paintCardBackground(ctx, W, H, { background: d.background, bgDarkPct: d.bgDarkPct, bgBlur: d.bgBlur });
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

  // full-width monochrome line chart
  const cx = 70, cw = W - 140, cy = 410, ch = 170;
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
    // monochrome line chart (closes) — light gray/white for B&W manga backgrounds
    const line = "rgba(232,232,232,0.92)";
    const area = ctx.createLinearGradient(0, cy, 0, cy + ch);
    area.addColorStop(0, "rgba(232,232,232,0.18)");
    area.addColorStop(1, "rgba(232,232,232,0)");
    ctx.beginPath();
    closes.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.lineTo(X(closes.length - 1), cy + ch);
    ctx.lineTo(X(0), cy + ch);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();
    ctx.beginPath();
    closes.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.strokeStyle = line;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.stroke();
    const dot = (x: number, y: number, fill: string, label: string, right: boolean) => {
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = "#0b0f14"; ctx.stroke();
      thin(ctx, 12); ctx.fillStyle = MUTED; ctx.textAlign = right ? "right" : "left";
      ctx.fillText(label, x + (right ? -10 : 10), y - 9); ctx.textAlign = "left";
    };
    const idxAt = (sec?: number) => {
      if (sec == null || !candles.length) return 0;
      let best = 0;
      for (let i = 0; i < candles.length; i++) if (candles[i].t <= sec) best = i;
      return best;
    };
    const ei = d.entryTime != null ? idxAt(d.entryTime) : 0;
    const xi = d.closed ? (d.exitTime != null ? idxAt(d.exitTime) : candles.length - 1) : -1;
    dot(X(ei), Y(d.entryPrice ?? candles[ei].c), TEXT, "entry", false);
    if (xi >= 0) dot(X(xi), Y(d.exitPrice ?? candles[xi].c), TEXT, "exit", true);
  } else {
    center("chart tidak tersedia", cy + ch / 2, 16, MUTED);
  }

  // stats row (Status removed)
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

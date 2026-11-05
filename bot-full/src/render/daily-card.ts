/**
 * Daily PnL summary card (Tusvicious) — same look as the PnL card: total PnL, stats, per-day bars.
 */
import { createCanvas } from "@napi-rs/canvas";
import { ensureCardFonts } from "./pnl-card.js";

export type DailyCardData = {
  title: string; // e.g. "7 hari terakhir"
  days: Array<{ key: string; pnlUsd: number; count: number }>;
  totalUsd: number;
  count: number;
  wins: number;
  winRate: number | null;
  feesUsd: number;
  capitalUsd: number;
  best?: { label: string; pnlUsd: number } | null;
  worst?: { label: string; pnlUsd: number } | null;
  timeLabel: string;
};

const MUTED = "#8a94a8", TEXT = "#e8ecf4", UP = "#34d399", DOWN = "#fb7185";
const money = (n: number, sign = false) =>
  `${sign ? (n >= 0 ? "+" : "-") : n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLbl = (k: string) => `${Number(k.slice(8, 10))} ${MON[Number(k.slice(5, 7)) - 1]}`;

export function renderDailyCard(d: DailyCardData): Buffer {
  ensureCardFonts();
  const W = 1200, H = 800;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const thin = (px: number) => (ctx.font = `${px}px CardText, CardSans, sans-serif`);
  const semi = (px: number) => (ctx.font = `${px}px CardSemi, CardSansBold, sans-serif`);
  const numf = (px: number) => (ctx.font = `${px}px CardNum, CardSansBold, sans-serif`);
  const up = d.totalUsd >= 0;
  const col = d.count ? (up ? UP : DOWN) : MUTED;
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W / 2, 230, 0, W / 2, 230, 420);
  g.addColorStop(0, `rgba(${up ? "52,211,153" : "251,113,133"},0.12)`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const center = (t: string, y: number, color: string) => {
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(t, W / 2, y);
    ctx.textAlign = "left";
  };
  semi(16); center("TUSVICIOUS", 78, MUTED);
  semi(28); center(`Daily PnL  ·  ${d.title}`, 128, TEXT);
  numf(104); center(money(d.totalUsd, true), 262, col);
  thin(18); center(`${d.count} posisi ditutup  ·  win rate ${d.winRate == null ? "n/a" : `${d.winRate.toFixed(0)}%`}`, 306, MUTED);

  // bars per day
  const cx = 70, cw = W - 140, cy = 350, ch = 220;
  const mid = cy + ch / 2;
  const mx = Math.max(1e-9, ...d.days.map((x) => Math.abs(x.pnlUsd)));
  ctx.fillStyle = "rgba(148,163,184,0.25)";
  ctx.fillRect(cx, Math.round(mid), cw, 1);
  const n = d.days.length;
  const slot = cw / Math.max(1, n);
  const bw = Math.max(4, Math.min(64, slot * 0.62));
  d.days.forEach((x, i) => {
    const bx = cx + i * slot + (slot - bw) / 2;
    const h = (Math.abs(x.pnlUsd) / mx) * (ch / 2 - 18);
    ctx.fillStyle = x.count === 0 ? "rgba(148,163,184,0.18)" : x.pnlUsd >= 0 ? UP : DOWN;
    if (x.count === 0) ctx.fillRect(bx, mid - 1, bw, 2);
    else if (x.pnlUsd >= 0) ctx.fillRect(bx, mid - Math.max(2, h), bw, Math.max(2, h));
    else ctx.fillRect(bx, mid, bw, Math.max(2, h));
    const every = n <= 10 ? 1 : Math.ceil(n / 10);
    if (i % every === 0 || i === n - 1) {
      thin(13); ctx.fillStyle = MUTED; ctx.textAlign = "center";
      ctx.fillText(dayLbl(x.key), bx + bw / 2, cy + ch + 22);
      if (n <= 10 && x.count) {
        ctx.fillStyle = x.pnlUsd >= 0 ? UP : DOWN;
        ctx.fillText(money(x.pnlUsd, true), bx + bw / 2, x.pnlUsd >= 0 ? mid - h - 10 : mid + h + 20);
      }
      ctx.textAlign = "left";
    }
  });

  // stats row
  const stats: Array<[string, string, string]> = [
    ["MODAL", money(d.capitalUsd), TEXT],
    ["FEES", money(d.feesUsd), UP],
    ["WIN / TOTAL", `${d.wins} / ${d.count}`, TEXT],
    ["TERBAIK", d.best ? `${d.best.label} ${money(d.best.pnlUsd, true)}` : "-", d.best ? (d.best.pnlUsd >= 0 ? UP : DOWN) : MUTED],
    ["TERBURUK", d.worst ? `${d.worst.label} ${money(d.worst.pnlUsd, true)}` : "-", d.worst ? (d.worst.pnlUsd >= 0 ? UP : DOWN) : MUTED],
  ];
  const sw = (W - 140) / stats.length;
  stats.forEach(([k, v, cl], i) => {
    const x = 70 + sw * i + sw / 2;
    ctx.textAlign = "center";
    semi(13); ctx.fillStyle = MUTED; ctx.fillText(k, x, 640);
    numf(v.length > 16 ? 18 : 22); ctx.fillStyle = cl; ctx.fillText(v, x, 674);
    ctx.textAlign = "left";
  });
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(70, 730, W - 140, 1);
  thin(14); ctx.fillStyle = MUTED; ctx.fillText(`daily · ${d.timeLabel}`, 70, 764);
  ctx.textAlign = "right"; ctx.fillStyle = TEXT; ctx.fillText("@dlmmbosku_bot", W - 70, 764); ctx.textAlign = "left";
  return c.toBuffer("image/png");
}

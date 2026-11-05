/**
 * Summary PnL card (Tusvicious) — period (day / week / month) and per-token aggregate.
 * Same look as the position PnL card: big total, sub line, bar chart, stats row, footer.
 */
import { createCanvas } from "@napi-rs/canvas";
import { ensureCardFonts } from "./pnl-card.js";

export type SummaryBar = { label: string; pnlUsd: number; empty?: boolean };
export type SummaryCardData = {
  kicker: string; // "Daily PnL", "Weekly PnL", "Token PnL"
  title: string; // "05 Nov 2026", "2–8 Nov 2026", "PIRATE"
  totalUsd: number;
  pnlPct: number | null;
  pnlSol: number | null;
  count: number;
  wins: number;
  winRate: number | null;
  capitalUsd: number;
  exitUsd?: number | null;
  feesUsd: number;
  best?: { label: string; pnlUsd: number } | null;
  worst?: { label: string; pnlUsd: number } | null;
  /** extra stat cells (e.g. DURASI, RANGE) — replace best/worst when given */
  extra?: Array<[string, string]>;
  bars: SummaryBar[];
  barsLabel?: string;
  footer: string;
};
/** @deprecated kept for older callers */
export type DailyCardData = SummaryCardData;

const MUTED = "#8a94a8", TEXT = "#e8ecf4", UP = "#34d399", DOWN = "#fb7185";
export const money = (n: number | null | undefined, sign = false) =>
  n == null || !Number.isFinite(n)
    ? "n/a"
    : `${sign ? (n >= 0 ? "+" : "-") : n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function renderSummaryCard(d: SummaryCardData): Buffer {
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
  semi(16); center("TUSVICIOUS", 70, MUTED);
  semi(28); center(`${d.kicker}  ·  ${d.title}`, 116, TEXT);
  numf(96); center(money(d.totalUsd, true), 236, col);
  const sub = [
    d.pnlPct == null ? null : `${d.pnlPct >= 0 ? "+" : "−"}${Math.abs(d.pnlPct).toFixed(2)}%`,
    d.pnlSol == null ? null : `${d.pnlSol >= 0 ? "+" : "−"}${Math.abs(d.pnlSol).toFixed(4)} SOL`,
    `${d.count} posisi`,
    `win rate ${d.winRate == null ? "n/a" : `${d.winRate.toFixed(0)}%`}`,
  ].filter(Boolean).join("  ·  ");
  semi(20); center(sub, 282, d.count ? col : MUTED);

  // bars
  const cx = 70, cw = W - 140, cy = 322, ch = 236;
  const mid = cy + ch / 2;
  const mx = Math.max(1e-9, ...d.bars.map((x) => Math.abs(x.pnlUsd)));
  ctx.fillStyle = "rgba(148,163,184,0.25)";
  ctx.fillRect(cx, Math.round(mid), cw, 1);
  if (d.barsLabel) { thin(12); ctx.fillStyle = MUTED; ctx.fillText(d.barsLabel, cx, cy - 6); }
  const n = d.bars.length;
  if (!n) { thin(18); center("Belum ada posisi ditutup", mid - 12, MUTED); }
  const slot = cw / Math.max(1, n);
  const bw = Math.max(3, Math.min(64, slot * 0.62));
  const every = n <= 12 ? 1 : Math.ceil(n / 10);
  d.bars.forEach((x, i) => {
    const bx = cx + i * slot + (slot - bw) / 2;
    const h = (Math.abs(x.pnlUsd) / mx) * (ch / 2 - 22);
    if (x.empty) { ctx.fillStyle = "rgba(148,163,184,0.18)"; ctx.fillRect(bx, mid - 1, bw, 2); }
    else {
      ctx.fillStyle = x.pnlUsd >= 0 ? UP : DOWN;
      if (x.pnlUsd >= 0) ctx.fillRect(bx, mid - Math.max(2, h), bw, Math.max(2, h));
      else ctx.fillRect(bx, mid, bw, Math.max(2, h));
    }
    ctx.textAlign = "center";
    if (i % every === 0 || i === n - 1) { thin(13); ctx.fillStyle = MUTED; ctx.fillText(x.label, bx + bw / 2, cy + ch + 22); }
    if (n <= 12 && !x.empty) {
      thin(13); ctx.fillStyle = x.pnlUsd >= 0 ? UP : DOWN;
      ctx.fillText(money(x.pnlUsd, true), bx + bw / 2, x.pnlUsd >= 0 ? mid - h - 9 : mid + h + 19);
    }
    ctx.textAlign = "left";
  });

  // stats row
  const stats: Array<[string, string, string]> = [
    ["MODAL", money(d.capitalUsd), TEXT],
    ...(d.exitUsd !== undefined ? [["EXIT", money(d.exitUsd), TEXT] as [string, string, string]] : []),
    ["FEES", money(d.feesUsd), UP],
    ["WIN / TOTAL", `${d.wins} / ${d.count}`, TEXT],
    ...(d.extra
      ? d.extra.map(([k, v]) => [k, v, TEXT] as [string, string, string])
      : ([
          ["TERBAIK", d.best ? `${d.best.label} ${money(d.best.pnlUsd, true)}` : "-", d.best ? (d.best.pnlUsd >= 0 ? UP : DOWN) : MUTED],
          ["TERBURUK", d.worst ? `${d.worst.label} ${money(d.worst.pnlUsd, true)}` : "-", d.worst ? (d.worst.pnlUsd >= 0 ? UP : DOWN) : MUTED],
        ] as Array<[string, string, string]>)),
  ];
  const sw = (W - 140) / stats.length;
  stats.forEach(([k, v, cl], i) => {
    const x = 70 + sw * i + sw / 2;
    ctx.textAlign = "center";
    semi(13); ctx.fillStyle = MUTED; ctx.fillText(k, x, 640);
    numf(v.length > 15 ? 17 : 22); ctx.fillStyle = cl; ctx.fillText(v, x, 674);
    ctx.textAlign = "left";
  });
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(70, 730, W - 140, 1);
  thin(14); ctx.fillStyle = MUTED; ctx.fillText(d.footer, 70, 764);
  ctx.textAlign = "right"; ctx.fillStyle = TEXT; ctx.fillText("@dlmmbosku_bot", W - 70, 764); ctx.textAlign = "left";
  return c.toBuffer("image/png");
}

/** @deprecated alias */
export const renderDailyCard = renderSummaryCard;

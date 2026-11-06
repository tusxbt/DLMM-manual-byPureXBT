/**
 * Summary PnL card (Tusvicious) — period (day / week / month) and per-token aggregate.
 * Same visual template as the per-position card (shared background, fonts, stats layout).
 * Chartless (history cards stay without a price chart).
 */
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { ensureCardFonts } from "./pnl-card.js";
import { paintCardBackground, type CardBgOpts } from "./card-bg.js";

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
  bars: SummaryBar[]; // kept for API compat; not drawn
  barsLabel?: string;
  footer: string;
  background?: string | null;
  bgDarkPct?: number | null;
  bgBlur?: number | null;
};
/** @deprecated kept for older callers */
export type DailyCardData = SummaryCardData;

const MUTED = "#8a94a8", TEXT = "#e8ecf4", UP = "#34d399", DOWN = "#fb7185";
export const money = (n: number | null | undefined, sign = false) =>
  n == null || !Number.isFinite(n)
    ? "n/a"
    : `${sign ? (n >= 0 ? "+" : "-") : n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const thin = (ctx: SKRSContext2D, px: number) => (ctx.font = `${px}px CardText, CardSans, sans-serif`);
const semi = (ctx: SKRSContext2D, px: number) => (ctx.font = `${px}px CardSemi, CardSansBold, sans-serif`);
const numf = (ctx: SKRSContext2D, px: number) => (ctx.font = `${px}px CardNum, CardSansBold, sans-serif`);

export function renderSummaryCard(d: SummaryCardData): Buffer {
  ensureCardFonts();
  // same canvas size as per-position card so the shared manga BG crops identically
  const W = 1200, H = 800;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const up = d.totalUsd >= 0;
  const col = d.count ? (up ? UP : DOWN) : MUTED;
  const rgb = up ? "52,211,153" : "251,113,133";

  const bgOpts: CardBgOpts = { background: d.background, bgDarkPct: d.bgDarkPct, bgBlur: d.bgBlur };
  paintCardBackground(ctx, W, H, bgOpts);

  // soft accent glow behind the number (same as position card)
  const g = ctx.createRadialGradient(W / 2, 250, 0, W / 2, 250, 420);
  g.addColorStop(0, `rgba(${rgb},0.13)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const center = (t: string, y: number, px: number, color: string, f: typeof thin = thin) => {
    f(ctx, px);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(t, W / 2, y);
    ctx.textAlign = "left";
  };

  center("TUSVICIOUS", 78, 16, MUTED, semi);
  center(`${d.kicker}  ·  ${d.title}`, 128, 28, TEXT, semi);

  // big PnL $ (summary cards lead with USD; % / SOL on the sub-line)
  center(money(d.totalUsd, true), 270, 112, col, numf);
  const sub = [
    d.pnlPct == null ? null : `${d.pnlPct >= 0 ? "+" : "−"}${Math.abs(d.pnlPct).toFixed(2)}%`,
    d.pnlSol == null ? null : `${d.pnlSol >= 0 ? "+" : "−"}${Math.abs(d.pnlSol).toFixed(4)} SOL`,
    `${d.count} posisi`,
    `win rate ${d.winRate == null ? "n/a" : `${d.winRate.toFixed(0)}%`}`,
  ].filter(Boolean).join("  ·  ");
  center(sub || "—", 330, 28, d.count ? col : MUTED, semi);
  if (!d.count) center("Belum ada posisi ditutup", 380, 18, MUTED);

  // stats row — same y-band as the position card
  const stats: Array<[string, string, string]> = [
    ["Modal", money(d.capitalUsd), TEXT],
    ...(d.exitUsd !== undefined ? [["Exit", money(d.exitUsd), TEXT] as [string, string, string]] : []),
    ["Fees", money(d.feesUsd), d.feesUsd > 0 ? UP : TEXT],
    ["Win / Tot", `${d.wins} / ${d.count}`, TEXT],
    ...(d.extra
      ? d.extra.map(([k, v]) => [k, v, TEXT] as [string, string, string])
      : ([
          ["Terbaik", d.best ? `${d.best.label} ${money(d.best.pnlUsd, true)}` : "-", d.best ? (d.best.pnlUsd >= 0 ? UP : DOWN) : MUTED],
          ["Terburuk", d.worst ? `${d.worst.label} ${money(d.worst.pnlUsd, true)}` : "-", d.worst ? (d.worst.pnlUsd >= 0 ? UP : DOWN) : MUTED],
        ] as Array<[string, string, string]>)),
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

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(70, 730, W - 140, 1);
  thin(ctx, 14);
  ctx.fillStyle = MUTED;
  ctx.fillText(d.footer, 70, 764);
  ctx.textAlign = "right";
  ctx.fillStyle = TEXT;
  ctx.fillText("@dlmmbosku_bot", W - 70, 764);
  ctx.textAlign = "left";
  return c.toBuffer("image/png");
}

/** @deprecated alias */
export const renderDailyCard = renderSummaryCard;

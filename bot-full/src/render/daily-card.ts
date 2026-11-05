/**
 * Summary PnL card (Tusvicious) — period (day / week / month) and per-token aggregate.
 * Same look as the position PnL card, no chart: big total, sub line (%/SOL/win rate), stats row, footer.
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
  const W = 1200, H = 630; // no chart → compact card
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const thin = (px: number) => (ctx.font = `${px}px CardText, CardSans, sans-serif`);
  const semi = (px: number) => (ctx.font = `${px}px CardSemi, CardSansBold, sans-serif`);
  const numf = (px: number) => (ctx.font = `${px}px CardNum, CardSansBold, sans-serif`);
  const up = d.totalUsd >= 0;
  const col = d.count ? (up ? UP : DOWN) : MUTED;
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W / 2, 250, 0, W / 2, 250, 440);
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
  semi(16); center("TUSVICIOUS", 66, MUTED);
  semi(30); center(`${d.kicker}  ·  ${d.title}`, 118, TEXT);
  numf(128); center(money(d.totalUsd, true), 262, col);
  const sub = [
    d.pnlPct == null ? null : `${d.pnlPct >= 0 ? "+" : "−"}${Math.abs(d.pnlPct).toFixed(2)}%`,
    d.pnlSol == null ? null : `${d.pnlSol >= 0 ? "+" : "−"}${Math.abs(d.pnlSol).toFixed(4)} SOL`,
    `${d.count} posisi`,
    `win rate ${d.winRate == null ? "n/a" : `${d.winRate.toFixed(0)}%`}`,
  ].filter(Boolean).join("  ·  ");
  semi(24); center(sub, 316, d.count ? col : MUTED);
  if (!d.count) { thin(18); center("Belum ada posisi ditutup", 352, MUTED); }

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
    semi(14); ctx.fillStyle = MUTED; ctx.fillText(k, x, 428);
    numf(v.length > 15 ? 20 : 27); ctx.fillStyle = cl; ctx.fillText(v, x, 468);
    ctx.textAlign = "left";
  });
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(70, 540, W - 140, 1);
  thin(14); ctx.fillStyle = MUTED; ctx.fillText(d.footer, 70, 578);
  ctx.textAlign = "right"; ctx.fillStyle = TEXT; ctx.fillText("@dlmmbosku_bot", W - 70, 578); ctx.textAlign = "left";
  return c.toBuffer("image/png");
}

/** @deprecated alias */
export const renderDailyCard = renderSummaryCard;

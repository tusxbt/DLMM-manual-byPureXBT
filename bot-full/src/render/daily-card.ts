/**
 * Summary PnL card (Tusvicious) — period (day / week / month) and per-token aggregate.
 * Same visual template as the per-position card (shared background, fonts, stats layout).
 * Middle: monochrome cumulative PnL step-line (nodes + +/- USD pills). No price chart.
 */
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { ensureCardFonts } from "./pnl-card.js";
import { paintCardBackground, type CardBgOpts } from "./card-bg.js";
import { activeDisplay, fmtMoney, fmtMoneyShort } from "../display-money.js";

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
  /** chronological steps for the cumulative PnL chart */
  bars: SummaryBar[];
  barsLabel?: string;
  footer: string;
  background?: string | null;
  bgDarkPct?: number | null;
  bgBlur?: number | null;
};
/** @deprecated kept for older callers */
export type DailyCardData = SummaryCardData;

const MUTED = "#8a94a8", TEXT = "#e8ecf4", UP = "#34d399", DOWN = "#fb7185";
const LINE = "rgba(232,236,244,0.92)";
const LINE_SOFT = "rgba(232,236,244,0.28)";
export const money = (n: number | null | undefined, sign = false) => fmtMoney(n, { sign, ...activeDisplay(), na: "n/a" });

const thin = (ctx: SKRSContext2D, px: number) => (ctx.font = `${px}px CardText, CardSans, sans-serif`);
const semi = (ctx: SKRSContext2D, px: number) => (ctx.font = `${px}px CardSemi, CardSansBold, sans-serif`);
const numf = (ctx: SKRSContext2D, px: number) => (ctx.font = `${px}px CardNum, CardSansBold, sans-serif`);

const shortMoney = (n: number) => {
  // n is already in display units when drawn from converted bars; here bars stay USD and convert in pill
  return fmtMoneyShort(n, activeDisplay());
};

/**
 * Monochrome cumulative PnL step-line.
 * White/light-gray step path, circle nodes, pill badges (+USD above / −USD below).
 */
export function drawCumulativeStep(
  ctx: SKRSContext2D,
  bars: SummaryBar[],
  label: string | undefined,
  box: { x: number; y: number; w: number; h: number },
): void {
  const pts = bars.filter((b) => !b.empty);
  const { x: cx, y: cy, w: cw, h: ch } = box;
  if (label) {
    thin(ctx, 12);
    ctx.fillStyle = MUTED;
    ctx.textAlign = "left";
    ctx.fillText(label.toUpperCase(), cx, cy - 8);
  }
  if (!pts.length) return;

  // pad for pills above/below nodes
  const padT = 28, padB = 28, padX = 18;
  const plotY = cy + padT;
  const plotH = ch - padT - padB;
  const plotX = cx + padX;
  const plotW = cw - padX * 2;

  let cum = 0;
  const series = pts.map((b) => {
    cum += b.pnlUsd;
    return { ...b, cum, delta: b.pnlUsd };
  });
  const vals = [0, ...series.map((s) => s.cum)];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;

  const n = series.length;
  const X = (i: number) => plotX + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const Y = (v: number) => plotY + plotH * (1 - (v - lo) / (hi - lo));

  // zero baseline
  const y0 = Y(0);
  ctx.strokeStyle = LINE_SOFT;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.moveTo(cx, y0);
  ctx.lineTo(cx + cw, y0);
  ctx.stroke();
  ctx.setLineDash([]);

  // soft fill under the step path
  ctx.beginPath();
  ctx.moveTo(X(0), y0);
  let prevY = y0;
  series.forEach((s, i) => {
    const x = X(i);
    const y = Y(s.cum);
    ctx.lineTo(x, prevY);
    ctx.lineTo(x, y);
    prevY = y;
  });
  ctx.lineTo(X(n - 1), cy + ch);
  ctx.lineTo(X(0), cy + ch);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, plotY, 0, cy + ch);
  grad.addColorStop(0, "rgba(232,236,244,0.14)");
  grad.addColorStop(1, "rgba(232,236,244,0)");
  ctx.fillStyle = grad;
  ctx.fill();

  // step stroke
  ctx.beginPath();
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  prevY = y0;
  ctx.moveTo(X(0), y0);
  // start from first node: horizontal from a slight left inset then step
  // classic step: H then V at each point from previous cum
  let px = X(0);
  // draw from zero at first x: vertical up/down to first cum, then continue
  {
    const y = Y(series[0].cum);
    ctx.lineTo(px, y);
    prevY = y;
  }
  for (let i = 1; i < n; i++) {
    const x = X(i);
    const y = Y(series[i].cum);
    ctx.lineTo(x, prevY); // horizontal
    ctx.lineTo(x, y); // vertical
    prevY = y;
    px = x;
  }
  ctx.stroke();

  // nodes + pills
  series.forEach((s, i) => {
    const x = X(i);
    const y = Y(s.cum);
    // node
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#0b0f14";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = TEXT;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(11,15,20,0.85)";
    ctx.stroke();

    // pill with delta (not cum)
    const txt = shortMoney(s.delta);
    const profit = s.delta >= 0;
    semi(ctx, 13);
    const tw = ctx.measureText(txt).width;
    const pw = tw + 16;
    const ph = 22;
    const px0 = x - pw / 2;
    const py0 = profit ? y - 18 - ph : y + 14;
    // clamp into box
    const px1 = Math.max(cx, Math.min(cx + cw - pw, px0));
    const py1 = Math.max(cy + 2, Math.min(cy + ch - ph - 2, py0));
    ctx.beginPath();
    const r = 11;
    ctx.moveTo(px1 + r, py1);
    ctx.arcTo(px1 + pw, py1, px1 + pw, py1 + ph, r);
    ctx.arcTo(px1 + pw, py1 + ph, px1, py1 + ph, r);
    ctx.arcTo(px1, py1 + ph, px1, py1, r);
    ctx.arcTo(px1, py1, px1 + pw, py1, r);
    ctx.closePath();
    ctx.fillStyle = profit ? "rgba(232,236,244,0.16)" : "rgba(40,44,52,0.92)";
    ctx.fill();
    ctx.strokeStyle = profit ? "rgba(232,236,244,0.55)" : "rgba(160,168,180,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = profit ? TEXT : MUTED;
    ctx.textAlign = "center";
    ctx.fillText(txt, px1 + pw / 2, py1 + 15);
    ctx.textAlign = "left";
  });

  // x labels (sparse)
  const every = n <= 8 ? 1 : Math.ceil(n / 8);
  series.forEach((s, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    thin(ctx, 12);
    ctx.fillStyle = MUTED;
    ctx.textAlign = "center";
    ctx.fillText(s.label.slice(0, 10), X(i), cy + ch + 16);
  });
  ctx.textAlign = "left";
}

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

  // big PnL $ — no sub-line (% / SOL / count / win rate)
  center(money(d.totalUsd, true), 270, 112, col, numf);
  if (!d.count) center("Belum ada posisi ditutup", 340, 18, MUTED);

  // cumulative step chart fills the empty middle (sub-line removed → more room)
  if (d.count && (d.bars?.length ?? 0) > 0) {
    drawCumulativeStep(ctx, d.bars, d.barsLabel || "PnL kumulatif", { x: 70, y: 340, w: W - 140, h: 260 });
  }

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

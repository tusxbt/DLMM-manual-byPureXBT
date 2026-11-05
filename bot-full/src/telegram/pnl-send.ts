import { bgForCurrentUser } from "./pnl-bg.js";
import type { MeteoraPnl } from "../engine/meteora-pnl.js";
/** Build + send PnL card photos. Never throws (image is best-effort, never blocks a close). */
import { InputFile, type Context } from "grammy";
import { log, redactSecrets } from "../logger.js";
import { fetchOhlcv } from "../engine/ohlcv.js";
import { renderPnlCard, preloadPnlBackground, type PnlCardData } from "../render/pnl-card.js";
import { fmtAge } from "./positions-view.js";
import { getTrackedPosition, type TrackedPosition } from "../store/positions.js";

export type PositionSnapshot = {
  pair?: string;
  pool: string;
  position: string;
  mint_x?: string;
  total_value_usd: number | null;
  unclaimed_fees_usd: number | null;
  cost_usd?: number;
  opened_at?: string;
  min_price?: number | null;
  max_price?: number | null;
  active_price?: number | null;
  entry_price?: number | null;
  /** Meteora datapi PnL (preferred) */
  meteora?: MeteoraPnl | null;
  strategy?: string | null;
  bins?: number | null;
  amount_sol?: number | null;
  exit_label?: string | null;
  /** realized from close txs (no rent, no tx fee) */
  realized?: RealizedOut | null;
};

export type RealizedOut = {
  solNet: number;
  tokenNet: Record<string, number>;
  rentSol: number;
  feeSol: number;
  exitUsd: number | null;
  pnlUsd: number | null;
  exitSol?: number | null;
  depositSol?: number | null;
  pnlSol?: number | null;
  pnlPct: number | null;
};

export function snapshotOf(p: Record<string, unknown>): PositionSnapshot {
  const n = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    pair: p.pair ? String(p.pair) : undefined,
    pool: String(p.pool),
    position: String(p.position),
    mint_x: p.mint_x ? String(p.mint_x) : undefined,
    total_value_usd: n(p.total_value_usd),
    unclaimed_fees_usd: n(p.unclaimed_fees_usd),
    cost_usd: n(p.cost_usd) ?? undefined,
    opened_at: p.opened_at ? String(p.opened_at) : undefined,
    min_price: n(p.min_price),
    max_price: n(p.max_price),
    active_price: n(p.active_price),
    entry_price: n(p.entry_price),
    meteora: (p.meteora as MeteoraPnl | undefined) ?? null,
    ...trackedExtras(p),
  };
}

function trackedExtras(p: Record<string, unknown>): Pick<PositionSnapshot, "strategy" | "bins" | "amount_sol"> {
  let t: TrackedPosition | undefined;
  try {
    t = getTrackedPosition(String(p.position));
  } catch {
    t = undefined;
  }
  const minB = Number(p.min_bin ?? t?.min_bin), maxB = Number(p.max_bin ?? t?.max_bin);
  const raw = (p.strategy_text as string) || t?.strategy_label || t?.strategy || null;
  return {
    strategy: raw ? (raw === raw.toLowerCase() ? raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : raw) : null,
    bins: Number.isFinite(minB) && Number.isFinite(maxB) ? maxB - minB + 1 : null,
    amount_sol: t?.amount_sol ?? null,
  };
}

export function kstStamp(d = new Date()): string {
  return (
    d.toLocaleString("en-GB", { timeZone: "Asia/Seoul", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "") + " KST"
  );
}

export function cardDataFromSnapshot(s: PositionSnapshot, closed: boolean, now = new Date()): PnlCardData {
  // closed: on-chain realized (close + swap txs) wins — Meteora values withdrawn tokens at market
  // and so ignores swap loss/slippage.
  const r0 = closed ? s.realized : null;
  if (r0 && r0.pnlUsd != null) {
    return {
      ...ownCard(s, closed, now),
      depositUsd: s.meteora?.depositUsd ?? ownCard(s, closed, now).depositUsd,
      exitUsd: r0.exitUsd,
      feesUsd: s.meteora?.feesUsd ?? ownCard(s, closed, now).feesUsd,
      pnlUsd: r0.pnlUsd,
      pnlPct: r0.pnlPct,
      modal: r0.depositSol ? `${+r0.depositSol.toFixed(4)} SOL` : null,
      source: "realized",
    };
  }
  const m = s.meteora;
  if (m && m.pnlUsd != null) {
    const exitM = closed
      ? m.withdrawUsd == null ? null : m.withdrawUsd + (m.feesUsd ?? 0)
      : m.balanceUsd == null ? null : m.balanceUsd + (m.unclaimedFeesUsd ?? 0);
    return {
      ...ownCard(s, closed, now),
      depositUsd: m.depositUsd,
      exitUsd: exitM,
      feesUsd: m.feesUsd,
      pnlUsd: m.pnlUsd,
      pnlPct: m.pnlPct,
      modal: m.depositUsd == null && s.amount_sol ? `${s.amount_sol} SOL` : null,
      source: "Meteora",
    };
  }
  const r = closed ? s.realized : null;
  if (r && r.pnlUsd != null) {
    return { ...ownCard(s, closed, now), exitUsd: r.exitUsd, pnlUsd: r.pnlUsd, pnlPct: r.pnlPct, source: "realized" };
  }
  return { ...ownCard(s, closed, now), source: "estimasi" };
}

function ownCard(s: PositionSnapshot, closed: boolean, now: Date): PnlCardData {
  const exitUsd = s.total_value_usd == null ? null : s.total_value_usd + (s.unclaimed_fees_usd ?? 0);
  const dep = s.cost_usd && s.cost_usd > 0 ? s.cost_usd : null;
  const pnlUsd = dep != null && exitUsd != null ? exitUsd - dep : null;
  return {
    pair: s.pair || "TOKEN/SOL",
    position: s.position,
    closed,
    depositUsd: dep,
    exitUsd,
    feesUsd: s.unclaimed_fees_usd,
    pnlUsd,
    pnlPct: pnlUsd != null && dep ? (pnlUsd / dep) * 100 : null,
    duration: fmtAge(s.opened_at, now.getTime()),
    minPrice: s.min_price ?? null,
    maxPrice: s.max_price ?? null,
    entryPrice: s.entry_price ?? null,
    exitPrice: s.active_price ?? null,
    entryTime: s.opened_at && Number.isFinite(Date.parse(s.opened_at)) ? Math.floor(Date.parse(s.opened_at) / 1000) : undefined,
    exitTime: Math.floor(now.getTime() / 1000),
    timeLabel: kstStamp(now),
    strategy: s.strategy ?? null,
    bins: s.bins ?? null,
    modal: dep == null && s.amount_sol ? `${s.amount_sol} SOL` : null,
    exitLabel: s.exit_label ?? null,
  };
}

/** Render PNG (with candles if available). Throws on render failure. */
export async function buildPnlCardPng(s: PositionSnapshot, closed: boolean): Promise<Buffer> {
  const d = cardDataFromSnapshot(s, closed);
  const toSec = Math.floor(Date.now() / 1000);
  const opened = s.opened_at ? Math.floor(Date.parse(s.opened_at) / 1000) : NaN;
  const fromSec = Number.isFinite(opened) ? opened : toSec - 24 * 3600;
  try {
    d.candles = await fetchOhlcv({ pool: s.pool, tokenMint: s.mint_x, fromSec, toSec });
  } catch (e) {
    log("pnl_card", `ohlcv failed: ${(e as Error).message}`, "warn");
  }
  Object.assign(d, bgForCurrentUser());
  await preloadPnlBackground(d.background);
  return renderPnlCard(d);
}

export async function sendPnlCard(ctx: Context, s: PositionSnapshot, closed: boolean): Promise<void> {
  try {
    const d = cardDataFromSnapshot(s, closed);
    const png = await buildPnlCardPng(s, closed);
    const pnl = d.pnlUsd == null ? "PnL n/a" : `PnL ${d.pnlUsd >= 0 ? "+" : "-"}$${Math.abs(d.pnlUsd).toFixed(2)} (${d.pnlPct!.toFixed(2)}%)`;
    await ctx.replyWithPhoto(new InputFile(png, "pnl.png"), {
      caption: `📈 **${d.pair}** · ${closed ? "closed" : "open"} · ${pnl}`,
    });
  } catch (e) {
    log("pnl_card", redactSecrets((e as Error).message), "warn");
  }
}

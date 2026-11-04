import type { MeteoraPnl } from "../engine/meteora-pnl.js";
/** Build + send PnL card photos. Never throws (image is best-effort, never blocks a close). */
import { InputFile, type Context } from "grammy";
import { log, redactSecrets } from "../logger.js";
import { fetchOhlcv } from "../engine/ohlcv.js";
import { renderPnlCard, type PnlCardData } from "../render/pnl-card.js";
import { fmtAge } from "./positions-view.js";

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
  };
}

export function kstStamp(d = new Date()): string {
  return (
    d.toLocaleString("en-GB", { timeZone: "Asia/Seoul", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "") + " KST"
  );
}

export function cardDataFromSnapshot(s: PositionSnapshot, closed: boolean, now = new Date()): PnlCardData {
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
      source: "Meteora",
    };
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

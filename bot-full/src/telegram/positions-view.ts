import { screen, section, kv, pnlLine } from "./layout.js";
import { fmtCompactUsd } from "../engine/supply.js";
import { getSupplyUi, marketCap, mcRangeText } from "../engine/supply.js";
import { getSolUsd } from "../engine/prices.js";
import { SOL_MINT, USDC_MINT } from "../config.js";
import { fetchPnlForPools, type MeteoraPnl } from "../engine/meteora-pnl.js";
import { sendPnlCard, snapshotOf } from "./pnl-send.js";
import { presentConfirm, isAutoConfirm, AUTO_BADGE } from "./confirm-ui.js";
/**
 * Positions view: one card message per DLMM position, edit-in-place refresh,
 * all actions routed through the existing Confirm/Cancel gate.
 */
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { loadConfig, CONFIRM_TTL_MS } from "../config.js";
import { fmtUsd, shortAddr, strategyLabel } from "../format.js";
import { redactSecrets } from "../logger.js";
import { getSession } from "./session.js";
import { confirmKeyboard, mainMenuKeyboard } from "./menus.js";
import { loadTrackedPositions, type TrackedPosition } from "../store/positions.js";
import { listLivePositions, searchPools, type LivePosition } from "../engine/dlmm-read.js";
import { createConfirm } from "../engine/confirm.js";
import { onReshapePos } from "./reshape-handlers.js";
import { onZapoutPos } from "./zapout-handlers.js";

const key = (ctx: Context) => String(ctx.chat?.id ?? "");
export const usdOrNa = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "n/a (harga tidak tersedia)" : fmtUsd(n));
const SUB = "₀₁₂₃₄₅₆₇₈₉";

/** 0.00000116 → "0.0₅116"; normal numbers keep ~4 significant digits. */
export function fmtTinyPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n === 0) return "0";
  if (n >= 1) return n >= 1000 ? n.toFixed(0) : Number(n.toPrecision(5)).toString();
  // z = count of 0s right after "0."
  const z = Math.max(0, Math.ceil(-Math.log10(n)) - 1);
  const sig = Math.round(n * Math.pow(10, z + 3));
  const digits = String(Math.min(sig, 999)).padStart(3, "0").replace(/0+$/, "") || "0";
  if (z >= 4) return `0.0${String(z).split("").map((d) => SUB[Number(d)]).join("")}${digits}`;
  return Number(n.toPrecision(4)).toString();
}

/** Text bar of current price inside [min,max]: "−96% ━━━━━━━━━━●━ +4%". */
/**
 * Bin fill bar, downsampled to `width` buckets: █ ≥50% of bins in bucket hold liquidity, ▒ some, ░ none.
 * Active bin marked ▼ (inside) or ◀/▶ at the edge when out of range.
 */
export function binBar(mask: string, minBin: number, activeId: number | null | undefined, width = 16): { bar: string; filled: number; total: number } {
  const total = mask.length;
  const filled = [...mask].filter((c) => c === "1").length;
  const w = Math.max(1, Math.min(width, total));
  const cells: string[] = [];
  for (let k = 0; k < w; k++) {
    const a = Math.floor((k * total) / w);
    const b = Math.max(a + 1, Math.floor(((k + 1) * total) / w));
    const seg = mask.slice(a, b);
    const f = [...seg].filter((c) => c === "1").length / seg.length;
    cells.push(f >= 0.5 ? "█" : f > 0 ? "▒" : "░");
  }
  let bar = cells.join("");
  if (activeId != null) {
    const i = activeId - minBin;
    if (i < 0) bar = `◀${bar}`;
    else if (i >= total) bar = `${bar}▶`;
    else {
      const k = Math.min(w - 1, Math.floor((i * w) / total));
      bar = cells.slice(0, k).join("") + "▼" + cells.slice(k + 1).join("");
    }
  }
  return { bar, filled, total };
}

export function rangeBar(min: number, max: number, now: number, width = 16): string {
  if (!(min > 0 && max > min && now > 0)) return "";
  const lo = (min / now - 1) * 100;
  const hi = (max / now - 1) * 100;
  const t = Math.log(now / min) / Math.log(max / min); // bins are geometric
  const pos = Math.round(Math.min(1, Math.max(0, t)) * (width - 1));
  const bar = Array.from({ length: width }, (_, i) => (i === pos ? "●" : "▬")).join("");
  const sgn = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(0)}%`;
  return `${sgn(lo)} ${t < 0 ? "◀" : ""}${bar}${t > 1 ? "▶" : ""} ${sgn(hi)}`;
}

export function fmtAge(fromIso: string | undefined, now = Date.now()): string | null {
  if (!fromIso) return null;
  const ms = now - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}j ${m % 60}m`;
  return `${Math.floor(h / 24)}h`;
}

export function kstTime(d = new Date()): string {
  return d.toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false });
}

export type PositionCard = LivePosition & { pair?: string; pool_name?: string; entry_price?: number; opened_at?: string; cost_usd?: number; strategy_text?: string; partial?: boolean; manual?: boolean; meteora?: MeteoraPnl | null; mc_min?: number | null; mc_max?: number | null; mc_now?: number | null };

export function renderPositionCard(p: PositionCard, now = new Date()): string {
  const pair = p.pair || "TOKEN/SOL";
  const m = p.meteora && p.meteora.pnlUsd != null ? p.meteora : null;
  const pu = m ? m.pnlUsd : p.pnl_usd;
  const pp = m ? m.pnlPct : p.pnl_pct;
  const bins = p.min_bin != null && p.max_bin != null ? p.max_bin - p.min_bin + 1 : null;
  const tag = [p.manual ? "manual" : p.strategy_text, bins != null ? `${bins} bins` : null].filter(Boolean).join(" · ");
  const pnl =
    pu == null
      ? "📈 PnL n/a"
      : `${pu >= 0 ? "📈 +" : "📉 −"}$${Math.abs(pu).toFixed(2)}${pp != null ? ` (${pp >= 0 ? "+" : "−"}${Math.abs(pp).toFixed(2)}%)` : ""}${m ? "" : " · estimasi"}`;
  const out: (string | null)[] = [
    `**${pair}** ${shortAddr(p.position)}${tag ? ` [${tag}]` : ""}`,
    p.partial ? "⚠️ Deploy sebagian" : null,
    "",
    `📊 Value: ${usdOrNa(p.total_value_usd)}`,
    pnl,
    `💵 Fee berjalan: ${usdOrNa(m?.unclaimedFeesUsd ?? p.unclaimed_fees_usd)}`,
    "",
  ];
  if (p.min_price != null && p.max_price != null) {
    out.push(`📐 ${fmtTinyPrice(p.min_price)}–${fmtTinyPrice(p.max_price)} (now ${fmtTinyPrice(p.active_price)}) ${pair}`);
    out.push(`🏷 MC ${fmtCompactUsd(p.mc_min)}–${fmtCompactUsd(p.mc_max)} (now ${fmtCompactUsd(p.mc_now)})`);
    if (p.active_price) out.push(rangeBar(p.min_price, p.max_price, p.active_price));
  } else {
    out.push(`📐 bins ${p.min_bin ?? "?"}–${p.max_bin ?? "?"} (aktif ${p.active_id ?? "?"})`);
  }
  if (p.bin_mask && p.min_bin != null) {
    const b = binBar(p.bin_mask, p.min_bin, p.active_id);
    out.push(`🧱 ${b.bar}`);
    out.push(`Bins terisi: ${b.filled}/${b.total}`);
  }
  out.push("");
  out.push(p.in_range == null ? "⚪ Range ?" : p.in_range ? "🟢 In-range" : "🔴 Out-of-range");
  out.push("");
  out.push(`🕐 ${fmtAge(p.opened_at, now.getTime()) ?? "n/a"} · updated ${kstTime(now)} KST`);
  out.push(`[Meteora](https://app.meteora.ag/dlmm/${p.pool}) · [Solscan](https://solscan.io/account/${p.position})`);
  out.push(`\`${p.position}\``);
  return out.filter((x): x is string => x !== null).join("\n");
}

export function positionKeyboard(addr: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🚪 Exit", `pv:exit:${addr}`)
    .text("💰 Claim fees", `pv:claim:${addr}`)
    .row()
    .text("⚡ → SOL", `pv:zap:${addr}`)
    .text("♻️ Reposition", `pv:repo:${addr}`)
    .row()
    .text("🔀 Flip", `pv:flip:${addr}`)
    .text("📈 Card", `pv:card:${addr}`)
    .row()
    .text("← Positions", "pv:list")
    .text("🔄 Refresh", `pv:ref:${addr}`);
}

const pairCache = new Map<string, string>();
async function pairName(pool: string, trackedName?: string): Promise<string> {
  if (trackedName) return trackedName.replace(/-/g, "/");
  if (pairCache.has(pool)) return pairCache.get(pool)!;
  try {
    const hit = (await searchPools(pool, 1))[0];
    const n = hit?.name ? hit.name.replace(/-/g, "/") : "";
    if (n) pairCache.set(pool, n);
    return n || "TOKEN/SOL";
  } catch {
    return "TOKEN/SOL";
  }
}

/** Per-wallet short cache: all on-chain DLMM positions (bot-opened or manual on meteora.ag). */
const CARDS_TTL_MS = 15_000;
const cardsCache = new Map<string, { at: number; cards: PositionCard[] }>();
export function clearCardsCache(): void {
  cardsCache.clear();
}

async function loadCards(opts: { fresh?: boolean } = {}): Promise<PositionCard[]> {
  const w = loadConfig({ requireTelegram: false, skipWallet: true }).walletPublicKey.toBase58();
  const hit = cardsCache.get(w);
  if (!opts.fresh && hit && Date.now() - hit.at < CARDS_TTL_MS) return hit.cards;
  const cards = await loadCardsUncached();
  cardsCache.set(w, { at: Date.now(), cards });
  return cards;
}

/** Merge on-chain positions (source of truth, per user wallet) with bot metadata; deduped by address. */
export function mergeCards(live: LivePosition[], tracked: TrackedPosition[], met: Map<string, MeteoraPnl>): Array<Partial<PositionCard> & LivePosition> {
  const seen = new Set<string>();
  const out: Array<Partial<PositionCard> & LivePosition> = [];
  for (const p of live) {
    if (seen.has(p.position)) continue;
    seen.add(p.position);
    const t = tracked.find((x) => x.position === p.position);
    const m = met.get(p.position) ?? null;
    out.push({
      ...p,
      manual: !t,
      pool_name: t?.pool_name,
      opened_at: t?.opened_at ?? m?.openedAt ?? undefined,
      cost_usd: t?.cost_usd,
      strategy_text: t ? t.strategy_label || (t.strategy ? strategyLabel(t.strategy) : undefined) : undefined,
      partial: !!t?.partial,
      meteora: m,
      entry_price: t?.entry_price,
    });
  }
  return out;
}

async function loadCardsUncached(): Promise<PositionCard[]> {
  const tracked = loadTrackedPositions();
  const cost: Record<string, number> = {};
  for (const t of tracked) if (t.cost_usd) cost[t.position] = t.cost_usd;
  const live = await listLivePositions(cost);
  // Meteora datapi PnL (same as UI) — one fetch per pool per refresh; missing → own 'estimasi'
  let met = new Map<string, MeteoraPnl>();
  try {
    const wallet = loadConfig({ requireTelegram: false, skipWallet: true }).walletPublicKey.toBase58();
    met = await fetchPnlForPools(live.map((p) => p.pool), wallet, "open");
  } catch {
    /* fallback */
  }
  // market cap: price × quote USD × on-chain supply (cached per mint)
  let solUsd: number | null = null;
  try {
    solUsd = await getSolUsd();
  } catch {
    solUsd = null;
  }
  const quoteUsd = (mint?: string) => (mint === SOL_MINT ? solUsd : mint === USDC_MINT ? 1 : null);
  const supplies = new Map<string, number | null>();
  await Promise.all([...new Set(live.map((p) => p.mint_x).filter(Boolean) as string[])].map(async (m) => supplies.set(m, await getSupplyUi(m))));
  const out: PositionCard[] = [];
  for (const c of mergeCards(live, tracked, met)) {
    const sup = c.mint_x ? supplies.get(c.mint_x) : null;
    const qu = quoteUsd(c.mint_y);
    out.push({
      ...c,
      mc_min: marketCap(c.min_price, qu, sup),
      mc_max: marketCap(c.max_price, qu, sup),
      mc_now: marketCap(c.active_price, qu, sup),
      pair: await pairName(c.pool, c.pool_name || undefined),
    } as PositionCard);
  }
  return out;
}

export const PAGE_SIZE = 8;

export function positionButtonLabel(p: PositionCard): string {
  const dot = p.in_range == null ? "⚪" : p.in_range ? "🟢" : "🔴";
  const pc = p.meteora?.pnlPct ?? p.pnl_pct;
  const pnl = pc == null ? "" : ` ${pc >= 0 ? "+" : "−"}${Math.abs(pc).toFixed(pc !== 0 && Math.abs(pc) < 10 ? 1 : 0)}%`;
  const pair = (p.pair || "TOKEN/SOL").slice(0, 16);
  return `${dot} ${pair} ${p.total_value_usd == null ? "n/a" : `$${Math.round(p.total_value_usd)}`}${pnl}`;
}

export function renderPositionList(cards: PositionCard[], page: number, autoBadge = false): { text: string; kb: InlineKeyboard; page: number } {
  const pages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
  const pg = Math.min(pages - 1, Math.max(0, page));
  const total = cards.reduce((a, c) => a + (c.total_value_usd || 0), 0);
  const unpriced = cards.filter((c) => c.total_value_usd == null).length;
  const fees = cards.reduce((a, c) => a + (c.unclaimed_fees_usd || 0), 0);
  const inR = cards.filter((c) => c.in_range).length;
  const text = screen(
    `📊 Posisi DLMM (${cards.length})`,
    autoBadge ? "⚡ Auto confirm close ON" : null,
    section(null, [
      kv("Total", `${fmtUsd(total)}${unpriced ? ` (+${unpriced} n/a)` : ""}`),
      kv("Fee", fmtUsd(fees)),
      kv("In range", `${inR}/${cards.length}`),
      pages > 1 ? kv("Hal", `${pg + 1}/${pages}`) : null,
    ]),
    section(null, [cards.length ? "Pilih posisi ⬇️" : "Tidak ada posisi terbuka.", `🕐 ${kstTime()} KST`]),
  );
  const kb = new InlineKeyboard();
  cards.slice(pg * PAGE_SIZE, pg * PAGE_SIZE + PAGE_SIZE).forEach((c, j) => {
    kb.text(positionButtonLabel(c), `pv:open:${c.position}`).row();
  });
  if (pages > 1) {
    if (pg > 0) kb.text("◀", `pv:pg:${pg - 1}`);
    kb.text(`${pg + 1}/${pages}`, "pv:noop");
    if (pg < pages - 1) kb.text("▶", `pv:pg:${pg + 1}`);
    kb.row();
  }
  kb.text("🔄 Refresh", "pv:lref").text("🏠 Home", "menu:cancel");
  return { text, kb, page: pg };
}

async function editOrReply(ctx: Context, msgId: number | undefined, text: string, kb: InlineKeyboard): Promise<void> {
  const opts = { reply_markup: kb, link_preview_options: { is_disabled: true } };
  if (msgId) {
    try {
      await ctx.api.editMessageText(ctx.chat!.id, msgId, text, opts);
      return;
    } catch (e) {
      if (/not modified/i.test(String((e as Error).message))) return;
    }
  }
  await ctx.reply(text, opts);
}

/** Single-message positions list. From a callback it edits that message; from a command it sends one. */
export async function showPositionCards(ctx: Context, opts: { refetch?: boolean; page?: number; fresh?: boolean } = {}): Promise<void> {
  const s = getSession(key(ctx));
  let msgId = opts.fresh ? undefined : ctx.callbackQuery?.message?.message_id;
  try {
    let cards = s.data.posList as unknown as PositionCard[] | undefined;
    if (!cards || opts.refetch !== false) {
      if (!msgId) msgId = (await ctx.reply("⏳ Loading positions DLMM…")).message_id;
      else await editOrReply(ctx, msgId, "⏳ Loading positions DLMM…", new InlineKeyboard());
      cards = await loadCards({ fresh: opts.refetch === true });
      s.data.posList = cards as unknown as Array<Record<string, unknown>>;
    }
    const r = renderPositionList(cards, opts.page ?? s.data.posPage ?? 0, isAutoConfirm());
    s.data.posPage = r.page;
    await editOrReply(ctx, msgId, r.text, r.kb);
  } catch (e) {
    await editOrReply(ctx, msgId, `❌ ${redactSecrets((e as Error).message)}`, mainMenuKeyboard());
  }
}

function confirmFor(kind: "claim" | "remove", p: PositionCard, reposition: boolean): { text: string; id: string } {
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const width = (p.max_bin ?? 0) - (p.min_bin ?? 0) + 1;
  const mode = cfg.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE";
  const val = p.total_value_usd == null ? "n/a" : fmtUsd(p.total_value_usd + (p.unclaimed_fees_usd ?? 0));
  const summary =
    kind === "remove"
      ? [
          `${reposition ? "♻️ Reposition (1/2) · Exit" : "🚪 Exit"} **${p.pair}** · ≈${val}`,
          reposition ? `Lalu panel Add ${Math.min(width, 1399)} bins (perlu Confirm lagi) · ${mode} · ${CONFIRM_TTL_MS / 1000}s` : `${mode} · konfirmasi ${CONFIRM_TTL_MS / 1000}s`,
        ].join("\n")
      : [
          `💰 Claim fees **${p.pair}** · ${usdOrNa(p.unclaimed_fees_usd)}`,
          `Pos \`${p.position}\``,
          `${mode} · konfirmasi ${CONFIRM_TTL_MS / 1000}s`,
        ].join("\n");
  const req = createConfirm({
    purpose: kind,
    summary,
    payload: {
      pool: p.pool,
      position: p.position,
      pool_name: p.pool_name,
      snapshot: kind === "remove" ? snapshotOf(p as unknown as Record<string, unknown>) : undefined,
      ...(reposition ? { reposition: { bins: Math.max(1, Math.min(1399, width)) } } : {}),
    },
  });
  return { text: summary, id: req.id };
}

export function registerPositionsView(bot: Bot): void {
  bot.callbackQuery("pv:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPositionCards(ctx, { refetch: false });
  });
  bot.callbackQuery("pv:lref", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Refresh…" });
    await showPositionCards(ctx, { refetch: true });
  });
  bot.callbackQuery("pv:noop", (ctx) => ctx.answerCallbackQuery());
  bot.callbackQuery(/^pv:pg:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPositionCards(ctx, { refetch: false, page: Number(ctx.match![1]) });
  });
  bot.callbackQuery(/^pv:open:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const r = await resolvePosition(ctx, ctx.match![1]);
    if (!r) return void (await editOrReply(ctx, ctx.callbackQuery.message?.message_id, "Posisi sudah tertutup / tidak ditemukan.", new InlineKeyboard().text("📊 Positions", "pv:lref")));
    await editOrReply(ctx, ctx.callbackQuery.message?.message_id, renderPositionCard(r.p), positionKeyboard(r.p.position));
  });

  // Legacy index-based buttons (old messages): send to a fresh list instead of dead-ending.
  bot.callbackQuery(/^pv:(open|exit|claim|zap|repo|flip|ref|card):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Menu lama — memuat ulang…" });
    await showPositionCards(ctx, { refetch: true });
  });

  bot.callbackQuery(/^pv:(exit|claim|zap|repo|flip|ref|card):([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    const action = ctx.match![1];
    const addr = ctx.match![2];
    const refetch = action === "ref";
    if (refetch) await ctx.answerCallbackQuery({ text: "Refresh…" });
    let r: Resolved | null;
    try {
      r = await resolvePosition(ctx, addr, refetch);
    } catch (e) {
      if (!refetch) await ctx.answerCallbackQuery();
      await ctx.reply(`❌ ${redactSecrets((e as Error).message)}`);
      return;
    }
    if (!r) {
      if (!refetch) await ctx.answerCallbackQuery({ text: "Posisi sudah tertutup." });
      try {
        await ctx.editMessageText(`${shortAddr(addr)} — posisi sudah tertutup.`, { reply_markup: new InlineKeyboard().text("📊 Positions", "pv:lref") });
      } catch {
        /* ignore */
      }
      return;
    }
    const { p, index } = r;
    if (action === "ref") {
      try {
        await ctx.editMessageText(renderPositionCard(p), { reply_markup: positionKeyboard(p.position), link_preview_options: { is_disabled: true } });
      } catch (e) {
        if (!/not modified/i.test(String((e as Error).message))) await ctx.reply(`❌ ${redactSecrets((e as Error).message)}`);
      }
      return;
    }
    if (action === "card") {
      await ctx.answerCallbackQuery({ text: "Membuat PnL card…" });
      await sendPnlCard(ctx, snapshotOf(p as unknown as Record<string, unknown>), false);
      return;
    }
    await ctx.answerCallbackQuery();
    if (action === "zap") return onZapoutPos(ctx, index);
    if (action === "flip") return onReshapePos(ctx, index);
    const c = confirmFor(action === "claim" ? "claim" : "remove", p, action === "repo");
    await presentConfirm(ctx, c.text, c.id);
  });
}

type Resolved = { p: PositionCard; index: number };

/**
 * Find a position by address: session cache first, else reload from chain (buttons never expire —
 * survives bot restarts / session resets). Keeps session.posList in sync so index-based
 * zapout/reshape handlers work.
 */
export async function resolvePosition(ctx: Context, addr: string, refetch = false, load: () => Promise<PositionCard[]> = () => loadCards({ fresh: refetch })): Promise<Resolved | null> {
  const s = getSession(key(ctx));
  let cards = s.data.posList as unknown as PositionCard[] | undefined;
  let index = !refetch && cards ? cards.findIndex((c) => c.position === addr) : -1;
  if (index < 0) {
    cards = await load();
    s.data.posList = cards as unknown as Array<Record<string, unknown>>;
    index = cards.findIndex((c) => c.position === addr);
  }
  return index < 0 || !cards ? null : { p: cards[index], index };
}

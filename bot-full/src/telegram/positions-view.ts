import { presentConfirm, isAutoConfirm, AUTO_BADGE } from "./confirm-ui.js";
/**
 * Positions view: one card message per DLMM position, edit-in-place refresh,
 * all actions routed through the existing Confirm/Cancel gate.
 */
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { loadConfig, CONFIRM_TTL_MS } from "../config.js";
import { fmtUsd, shortAddr } from "../format.js";
import { redactSecrets } from "../logger.js";
import { getSession } from "./session.js";
import { confirmKeyboard, mainMenuKeyboard } from "./menus.js";
import { loadTrackedPositions } from "../store/positions.js";
import { listLivePositions, searchPools, type LivePosition } from "../engine/dlmm-read.js";
import { createConfirm } from "../engine/confirm.js";
import { onReshapePos } from "./reshape-handlers.js";
import { onZapoutPos } from "./zapout-handlers.js";

const key = (ctx: Context) => String(ctx.chat?.id ?? "");
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
export function rangeBar(min: number, max: number, now: number, width = 12): string {
  if (!(min > 0 && max > min && now > 0)) return "";
  const lo = (min / now - 1) * 100;
  const hi = (max / now - 1) * 100;
  const t = Math.log(now / min) / Math.log(max / min); // bins are geometric
  const pos = Math.round(Math.min(1, Math.max(0, t)) * (width - 1));
  const bar = Array.from({ length: width }, (_, i) => (i === pos ? "●" : "━")).join("");
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

export type PositionCard = LivePosition & { pair?: string; pool_name?: string; opened_at?: string; cost_usd?: number };

export function renderPositionCard(p: PositionCard, now = new Date()): string {
  const pair = p.pair || "TOKEN/SOL";
  const pnl =
    p.pnl_usd == null || p.pnl_pct == null
      ? "📈 PnL n/a (deposit USD tidak tercatat)"
      : `${p.pnl_usd >= 0 ? "📈 +" : "📉 −"}$${Math.abs(p.pnl_usd).toFixed(2)} (${p.pnl_pct >= 0 ? "+" : "−"}${Math.abs(p.pnl_pct).toFixed(2)}%)`;
  const lines = [
    `${pair} ${shortAddr(p.position)} [DLMM]`,
    "",
    `📊 Value: ${fmtUsd(p.total_value_usd)}`,
    pnl,
    `💵 Fee berjalan: ${fmtUsd(p.unclaimed_fees_usd)}`,
    "",
  ];
  if (p.min_price != null && p.max_price != null) {
    lines.push(`📐 ${fmtTinyPrice(p.min_price)}–${fmtTinyPrice(p.max_price)} (now ${fmtTinyPrice(p.active_price)}) ${pair}`);
    const bar = p.active_price ? rangeBar(p.min_price, p.max_price, p.active_price) : "";
    if (bar) lines.push(bar);
  } else {
    lines.push(`📐 bins ${p.min_bin ?? "?"}–${p.max_bin ?? "?"} (aktif ${p.active_id ?? "?"})`);
  }
  lines.push("");
  lines.push(p.in_range == null ? "⚪ Range tidak diketahui" : p.in_range ? "🟢 In-range" : "🔴 Out-of-range");
  lines.push("");
  const age = fmtAge(p.opened_at, now.getTime());
  lines.push(`🕐 ${age ?? "umur n/a"} · updated ${kstTime(now)} (KST)`);
  lines.push(`https://app.meteora.ag/dlmm/${p.pool}`);
  return lines.join("\n");
}

export function positionKeyboard(i: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🚪 Exit", `pv:exit:${i}`)
    .text("💰 Claim fees", `pv:claim:${i}`)
    .row()
    .text("⚡ → SOL", `pv:zap:${i}`)
    .text("♻️ Reposition", `pv:repo:${i}`)
    .row()
    .text("🔀 Flip", `pv:flip:${i}`)
    .text("🔄 Refresh", `pv:ref:${i}`)
    .row()
    .text("← Positions", "pv:list");
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

async function loadCards(): Promise<PositionCard[]> {
  const tracked = loadTrackedPositions();
  const cost: Record<string, number> = {};
  for (const t of tracked) if (t.cost_usd) cost[t.position] = t.cost_usd;
  const live = await listLivePositions(cost);
  const out: PositionCard[] = [];
  for (const p of live) {
    const t = tracked.find((x) => x.position === p.position);
    out.push({
      ...p,
      pool_name: t?.pool_name,
      opened_at: t?.opened_at,
      cost_usd: t?.cost_usd,
      pair: await pairName(p.pool, t?.pool_name || undefined),
    } as PositionCard);
  }
  return out;
}

export const PAGE_SIZE = 8;

export function positionButtonLabel(p: PositionCard): string {
  const dot = p.in_range == null ? "⚪" : p.in_range ? "🟢" : "🔴";
  const pnl = p.pnl_pct == null ? "" : ` ${p.pnl_pct >= 0 ? "+" : "−"}${Math.abs(p.pnl_pct).toFixed(p.pnl_pct !== 0 && Math.abs(p.pnl_pct) < 10 ? 1 : 0)}%`;
  const pair = (p.pair || "TOKEN/SOL").slice(0, 16);
  return `${dot} ${pair} $${Math.round(p.total_value_usd)}${pnl}`;
}

export function renderPositionList(cards: PositionCard[], page: number, autoBadge = false): { text: string; kb: InlineKeyboard; page: number } {
  const pages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
  const pg = Math.min(pages - 1, Math.max(0, page));
  const total = cards.reduce((a, c) => a + (c.total_value_usd || 0), 0);
  const fees = cards.reduce((a, c) => a + (c.unclaimed_fees_usd || 0), 0);
  const inR = cards.filter((c) => c.in_range).length;
  const text = [
    `📊 ${cards.length} posisi DLMM`,
    autoBadge ? `${AUTO_BADGE} — 🚪 Exit & ⚡ → SOL tanpa Confirm` : null,
    "",
    `💼 Total value: ${fmtUsd(total)}`,
    `💵 Fee berjalan: ${fmtUsd(fees)}`,
    `🟢 ${inR} in-range · 🔴 ${cards.length - inR} out`,
    pages > 1 ? `Hal ${pg + 1}/${pages}` : null,
    "",
    cards.length ? "Pilih posisi:" : "Tidak ada posisi DLMM terbuka.",
    `🕐 updated ${kstTime()} (KST)`,
  ]
    .filter((x) => x !== null)
    .join("\n");
  const kb = new InlineKeyboard();
  cards.slice(pg * PAGE_SIZE, pg * PAGE_SIZE + PAGE_SIZE).forEach((c, j) => {
    kb.text(positionButtonLabel(c), `pv:open:${pg * PAGE_SIZE + j}`).row();
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
export async function showPositionCards(ctx: Context, opts: { refetch?: boolean; page?: number } = {}): Promise<void> {
  const s = getSession(key(ctx));
  let msgId = ctx.callbackQuery?.message?.message_id;
  try {
    let cards = s.data.posList as unknown as PositionCard[] | undefined;
    if (!cards || opts.refetch !== false) {
      if (!msgId) msgId = (await ctx.reply("⏳ Loading positions DLMM…")).message_id;
      else await editOrReply(ctx, msgId, "⏳ Loading positions DLMM…", new InlineKeyboard());
      cards = await loadCards();
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
  const summary = [
    kind === "claim" ? "💰 Claim fees" : reposition ? "♻️ Reposition — langkah 1: Exit (remove 100% + close)" : "🚪 Exit (remove 100% + close)",
    `Pool: ${p.pair} · Pos ${shortAddr(p.position)}`,
    `Value ${fmtUsd(p.total_value_usd)} | fees ${fmtUsd(p.unclaimed_fees_usd)}`,
    reposition ? `Langkah 2: panel Add terbuka dengan ${Math.min(width, 69)} bins di sekitar harga sekarang (perlu Preview + Confirm lagi).` : "",
    cfg.dryRun ? "Mode: DRY_RUN" : "Mode: LIVE",
    `Konfirmasi dalam ${CONFIRM_TTL_MS / 1000}s.`,
  ]
    .filter(Boolean)
    .join("\n");
  const req = createConfirm({
    purpose: kind,
    summary,
    payload: {
      pool: p.pool,
      position: p.position,
      pool_name: p.pool_name,
      ...(reposition ? { reposition: { bins: Math.max(1, Math.min(69, width)) } } : {}),
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
  bot.callbackQuery(/^pv:open:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const i = Number(ctx.match![1]);
    const p = (getSession(key(ctx)).data.posList as unknown as PositionCard[] | undefined)?.[i];
    if (!p) return showPositionCards(ctx, { refetch: true });
    await editOrReply(ctx, ctx.callbackQuery.message?.message_id, renderPositionCard(p), positionKeyboard(i));
  });

  bot.callbackQuery(/^pv:(exit|claim|zap|repo|flip|ref):(\d+)$/, async (ctx) => {
    const action = ctx.match![1];
    const i = Number(ctx.match![2]);
    const s = getSession(key(ctx));
    const p = s.data.posList?.[i] as unknown as PositionCard | undefined;
    if (!p) {
      await ctx.answerCallbackQuery({ text: "Daftar kadaluarsa — buka 📊 Positions lagi." });
      return;
    }
    if (action === "ref") {
      await ctx.answerCallbackQuery({ text: "Refresh…" });
      try {
        const cards = await loadCards();
        const idx = cards.findIndex((c) => c.position === p.position);
        s.data.posList = cards as unknown as Array<Record<string, unknown>>;
        if (idx < 0) {
          await ctx.editMessageText(`${p.pair} ${shortAddr(p.position)} — posisi sudah tertutup.`);
          return;
        }
        try {
          await ctx.editMessageText(renderPositionCard(cards[idx]), {
            reply_markup: positionKeyboard(idx),
            link_preview_options: { is_disabled: true },
          });
        } catch (e) {
          if (!/not modified/i.test(String((e as Error).message))) throw e;
        }
      } catch (e) {
        await ctx.reply(`❌ ${redactSecrets((e as Error).message)}`);
      }
      return;
    }
    await ctx.answerCallbackQuery();
    if (action === "zap") return onZapoutPos(ctx, i);
    if (action === "flip") return onReshapePos(ctx, i);
    const c = confirmFor(action === "claim" ? "claim" : "remove", p, action === "repo");
    await presentConfirm(ctx, c.text, c.id);
  });
}

/**
 * 🎯 TP/SL per position (PnL % — Meteora PnL, fallback bot PnL). Alerts only: never sends a tx.
 * Alert buttons go to the normal Exit / Zapout Preview+Confirm flows.
 */
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { getTpsl, setTpsl, loadTpsl, markFired, dropTpsl, tpslTrigger, fmtPct, tpslLine, type TpslEntry } from "../store/tpsl.js";
import { resolvePosition, loadCards, type PositionCard } from "./positions-view.js";
import { getSession, askPrompt, RETRY } from "./session.js";
import { runAsUser } from "../users/context.js";
import { listUsers, ownerId, hasWallet } from "../users/store.js";
import { shortAddr } from "../format.js";
import { code } from "./html.js";
import { log } from "../logger.js";

const ADDR = "([1-9A-HJ-NP-Za-km-z]{32,44})";
export const TP_PRESETS = [10, 25, 50, 100];
export const SL_PRESETS = [5, 10, 20, 30];
const pnlOf = (p: PositionCard): number | null => p.meteora?.pnlPct ?? p.pnl_pct ?? null;

export function tpslMenu(p: { position: string; pair?: string; pool_name?: string }, e: TpslEntry | null, pnl: number | null): { text: string; kb: InlineKeyboard } {
  const a = p.position;
  const text = [
    `🎯 **TP/SL** — ${p.pair || p.pool_name || "posisi"} · ${code(shortAddr(a))}`,
    `PnL sekarang: ${pnl == null ? "n/a" : fmtPct(Math.round(pnl * 100) / 100)}`,
    `TP: ${e?.tp != null ? fmtPct(e.tp) : "—"} · SL: ${e?.sl != null ? fmtPct(e.sl) : "—"}`,
    "Hanya alert DM (cek ~45 detik), tidak ada transaksi otomatis.",
  ].join("\n");
  const kb = new InlineKeyboard();
  for (const v of TP_PRESETS) kb.text(`TP +${v}%`, `tp:t:${v}:${a}`);
  kb.row();
  for (const v of SL_PRESETS) kb.text(`SL −${v}%`, `tp:s:${v}:${a}`);
  kb.row().text("✏️ TP custom", `tp:tc:${a}`).text("✏️ SL custom", `tp:sc:${a}`).row();
  if (e?.tp != null) kb.text("🗑 Hapus TP", `tp:t:x:${a}`);
  if (e?.sl != null) kb.text("🗑 Hapus SL", `tp:s:x:${a}`);
  kb.row().text("⬅️ Kembali", `pv:open:${a}`);
  return { text, kb };
}

export function alertText(p: { position: string; pair?: string; pool_name?: string }, side: "tp" | "sl", e: TpslEntry, pnl: number): string {
  const target = side === "tp" ? e.tp! : e.sl!;
  return [
    `${side === "tp" ? "🟢 **TP tercapai**" : "🔴 **SL tersentuh**"} — ${p.pair || p.pool_name || e.pair || "posisi"} · ${code(shortAddr(p.position))}`,
    `PnL ${fmtPct(Math.round(pnl * 100) / 100)} (target ${fmtPct(target)})`,
    "Tidak ada transaksi otomatis — pilih aksi (lewat Preview + Confirm):",
  ].join("\n");
}
export const alertKeyboard = (a: string) =>
  new InlineKeyboard().text("🚪 Exit", `pv:exit:${a}`).text("⚡ Zapout", `pv:zap:${a}`).row().text("🙈 Abaikan", `tp:ign:${a}`);

/** Parse "25", "+25%", "-10" → positive number, else null. */
export function parsePct(t: string): number | null {
  const n = Number(String(t).replace(/[%+\s]/g, "").replace(/^[-−]/, ""));
  return Number.isFinite(n) && n > 0 && n <= 10000 ? n : null;
}

async function show(ctx: Context, addr: string, msgId?: number): Promise<void> {
  const r = await resolvePosition(ctx, addr).catch(() => null);
  if (!r) return void (await ctx.reply("Posisi sudah tertutup."));
  const m = tpslMenu(r.p, getTpsl(addr), pnlOf(r.p));
  const id = msgId ?? ctx.callbackQuery?.message?.message_id;
  if (id) {
    try {
      await ctx.api.editMessageText(ctx.chat!.id, id, m.text, { reply_markup: m.kb });
      return;
    } catch (e) {
      if (/not modified/i.test(String((e as Error).message))) return;
    }
  }
  await ctx.reply(m.text, { reply_markup: m.kb });
}

export function registerTpslUi(bot: Bot): void {
  bot.callbackQuery(new RegExp(`^tp:m:${ADDR}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, ctx.match![1]);
  });
  bot.callbackQuery(new RegExp(`^tp:(t|s):(\\d+|x):${ADDR}$`), async (ctx) => {
    const [, side, v, a] = ctx.match!;
    const r = await resolvePosition(ctx, a).catch(() => null);
    const val = v === "x" ? null : Number(v);
    setTpsl(a, { [side === "t" ? "tp" : "sl"]: val, pool: r ? String(r.p.pool) : undefined, pair: r?.p.pair });
    await ctx.answerCallbackQuery({ text: val == null ? "Dihapus" : `${side === "t" ? "TP" : "SL"} diset` });
    await show(ctx, a);
  });
  bot.callbackQuery(new RegExp(`^tp:(tc|sc):${ADDR}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, kind, a] = ctx.match!;
    const panel = ctx.callbackQuery.message?.message_id;
    const chat = String(ctx.chat?.id ?? "");
    const label = kind === "tc" ? "TP" : "SL";
    getSession(chat).awaitingText = async (text) => {
      const n = parsePct(text);
      if (n == null) {
        await askPrompt(ctx, chat, `Angka % tidak valid. Ketik ${label} %, mis. 25:`);
        return RETRY;
      }
      setTpsl(a, { [kind === "tc" ? "tp" : "sl"]: n });
      await show(ctx, a, panel);
    };
    await askPrompt(ctx, chat, `Ketik ${label} % (mis. ${kind === "tc" ? "40" : "15"}):`);
  });
  bot.callbackQuery(new RegExp(`^tp:ign:${ADDR}$`), async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Diabaikan — tidak di-alert lagi sampai TP/SL diubah" });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("🎯 Atur TP/SL", `tp:m:${ctx.match![1]}`) }).catch(() => undefined);
  });
}

/** One scan for the user in scope. Returns alerts sent. */
export async function scanTpsl(send: (text: string, kb: InlineKeyboard) => Promise<unknown>): Promise<number> {
  const all = loadTpsl();
  const keys = Object.keys(all);
  if (!keys.length) return 0;
  const cards = await loadCards(); // 15s cache shared with the Positions menu
  const live = new Map(cards.map((c) => [c.position, c]));
  let sent = 0;
  for (const pos of keys) {
    const p = live.get(pos);
    if (!p) {
      if (cards.length) dropTpsl(pos); // closed → forget (never on an empty/failed read)
      continue;
    }
    const pnl = pnlOf(p);
    const side = tpslTrigger(all[pos], pnl);
    if (!side) continue;
    markFired(pos, side); // mark first → exactly one alert per trigger
    await send(alertText(p, side, all[pos], pnl!), alertKeyboard(pos));
    sent++;
  }
  return sent;
}

export const TPSL_INTERVAL_MS = 45_000;
export function startTpslMonitor(bot: Bot): NodeJS.Timeout {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const owner = ownerId();
      const ids = [...(owner ? [{ id: owner, isOwner: true }] : []), ...listUsers().filter((u) => hasWallet(u.id)).map((u) => ({ id: u.id, isOwner: false }))];
      for (const u of ids) {
        await runAsUser({ userId: u.id, isOwner: u.isOwner }, () =>
          scanTpsl((text, kb) => bot.api.sendMessage(u.id, text, { reply_markup: kb })),
        ).catch((e) => log("tpsl", `scan ${u.id}: ${(e as Error).message}`, "warn"));
      }
    } finally {
      busy = false;
    }
  };
  return setInterval(tick, TPSL_INTERVAL_MS);
}
export { tpslLine };

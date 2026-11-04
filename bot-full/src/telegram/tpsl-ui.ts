/**
 * 🎯 TP/SL per position (PnL % — Meteora PnL, fallback bot PnL). Alerts only: never sends a tx.
 * Alert buttons go to the normal Exit / Zapout Preview+Confirm flows.
 */
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { getTpsl, setTpsl, setAuto, loadTpsl, markFired, dropTpsl, tpslTrigger, fmtPct, tpslLine, type TpslEntry } from "../store/tpsl.js";
import { fetchPnlForPools } from "../engine/meteora-pnl.js";
import { loadConfig } from "../config.js";
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
    e?.auto ? "🤖 Auto zapout ON — saat TP/SL kena, bot zapout OTOMATIS (tanpa Confirm)." : "Alert DM saja (cek tiap 15 detik), tanpa transaksi otomatis.",
  ].join("\n");
  const kb = new InlineKeyboard();
  for (const v of TP_PRESETS) kb.text(`TP +${v}%`, `tp:t:${v}:${a}`);
  kb.row();
  for (const v of SL_PRESETS) kb.text(`SL −${v}%`, `tp:s:${v}:${a}`);
  kb.row().text("✏️ TP custom", `tp:tc:${a}`).text("✏️ SL custom", `tp:sc:${a}`).row();
  if (e?.tp != null) kb.text("🗑 Hapus TP", `tp:t:x:${a}`);
  if (e?.sl != null) kb.text("🗑 Hapus SL", `tp:s:x:${a}`);
  if (e?.tp != null || e?.sl != null) kb.row().text(`🤖 Auto zapout: ${e?.auto ? "ON" : "OFF"}`, e?.auto ? `tp:a0:${a}` : `tp:a1:${a}`);
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
    syncTpslMonitor();
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
      const rp = await resolvePosition(ctx, a).catch(() => null);
      setTpsl(a, { [kind === "tc" ? "tp" : "sl"]: n, pool: rp ? String(rp.p.pool) : undefined, pair: rp?.p.pair });
      syncTpslMonitor();
      await show(ctx, a, panel);
    };
    await askPrompt(ctx, chat, `Ketik ${label} % (mis. ${kind === "tc" ? "40" : "15"}):`);
  });
  bot.callbackQuery(new RegExp(`^tp:a1:${ADDR}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const a = ctx.match![1];
    await ctx.editMessageText(AUTO_WARN, { reply_markup: new InlineKeyboard().text("✅ Aktifkan auto zapout", `tp:a2:${a}`).row().text("⬅️ Batal", `tp:m:${a}`) });
  });
  bot.callbackQuery(new RegExp(`^tp:a(0|2):${ADDR}$`), async (ctx) => {
    const on = ctx.match![1] === "2";
    const ok = setAuto(ctx.match![2], on);
    await ctx.answerCallbackQuery({ text: ok ? (on ? "🤖 Auto zapout ON" : "Auto zapout OFF") : "Set TP atau SL dulu" });
    await show(ctx, ctx.match![2]);
  });
  bot.callbackQuery(new RegExp(`^tp:ign:${ADDR}$`), async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Diabaikan — tidak di-alert lagi sampai TP/SL diubah" });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("🎯 Atur TP/SL", `tp:m:${ctx.match![1]}`) }).catch(() => undefined);
  });
}

export const AUTO_WARN = [
  "⚠️ **Auto zapout**",
  "Saat TP atau SL kena, bot akan OTOMATIS menjalankan zapout TANPA Confirm:",
  "withdraw 100% + claim fee + close, lalu swap token → SOL (Jupiter), ditandatangani wallet bot kamu.",
  "Swap di atas MAX_SWAP_USD dilewati (token tetap di wallet). Gagal → coba 1x lagi, lalu DM tombol manual.",
  "Lanjut aktifkan?",
].join("\n");

/** Has a TP or SL that has not fired yet. */
export const isArmed = (e: TpslEntry) => (e.tp != null && !e.firedTp) || (e.sl != null && !e.firedSl);
const misses = new Map<string, number>();
export type ScanHooks = {
  send: (text: string, kb: InlineKeyboard) => Promise<unknown>;
  auto?: (pos: { position: string; pool: string; pair?: string; pool_name?: string }, why: string) => Promise<unknown>;
  /** test hook: pnl by position */
  fetchPnl?: (pools: string[]) => Promise<Map<string, { pnlPct: number | null; closed?: boolean }>>;
};

/**
 * One scan for the user in scope. Only positions with TP/SL are checked, via Meteora datapi PnL
 * (one request per pool that has a target) — no RPC position reads. Returns triggers handled.
 */
export async function scanTpsl(h: ScanHooks): Promise<number> {
  const all = loadTpsl();
  const keys = Object.keys(all).filter((k) => isArmed(all[k]));
  if (!keys.length) return 0;
  if (keys.some((k) => !all[k].pool)) {
    // legacy entries without pool → one positions read to fill it in
    const cards = await loadCards().catch(() => [] as PositionCard[]);
    for (const k of keys)
      if (!all[k].pool) {
        const c = cards.find((x) => x.position === k);
        if (c) {
          all[k].pool = String(c.pool);
          setTpsl(k, { pool: String(c.pool), pair: c.pair });
        }
      }
  }
  const pools = [...new Set(keys.map((k) => all[k].pool).filter(Boolean) as string[])];
  const fetchPnl =
    h.fetchPnl ??
    (async (ps: string[]) => fetchPnlForPools(ps, loadConfig({ requireTelegram: false, skipWallet: true }).walletPublicKey.toBase58(), "open"));
  const pnl = pools.length ? await fetchPnl(pools) : new Map();
  let n = 0;
  for (const pos of keys) {
    const e = all[pos];
    const m = pnl.get(pos);
    if (!m || m.closed) {
      // datapi lag tolerance: forget after ~1 min of misses (only when its pool answered something)
      const c = (misses.get(pos) ?? 0) + 1;
      misses.set(pos, c);
      if (c >= 4 && pnl.size) {
        dropTpsl(pos);
        misses.delete(pos);
      }
      continue;
    }
    misses.delete(pos);
    const side = tpslTrigger(e, m.pnlPct);
    if (!side) continue;
    markFired(pos, side); // mark first → exactly one alert/auto per trigger
    const card = { position: pos, pool: String(e.pool), pair: e.pair, pool_name: e.pool_name };
    if (e.auto && h.auto) {
      await h.auto(card, `${side === "tp" ? "TP" : "SL"} ${fmtPct(Math.round(m.pnlPct! * 100) / 100)}`);
    } else {
      await h.send(alertText(card, side, e, m.pnlPct!), alertKeyboard(pos));
    }
    n++;
  }
  return n;
}

export const TPSL_INTERVAL_MS = 15_000;
type Scope = { id: string; isOwner: boolean };
const scopes = (): Scope[] => {
  const owner = ownerId();
  return [...(owner ? [{ id: owner, isOwner: true }] : []), ...listUsers().filter((u) => hasWallet(u.id)).map((u) => ({ id: u.id, isOwner: false }))];
};
/** Users (in scope order) that have at least one TP/SL target. Pure fs reads, no network. */
export function usersWithTpsl(): Scope[] {
  return scopes().filter((u) => runAsUser({ userId: u.id, isOwner: u.isOwner }, () => Object.values(loadTpsl()).some(isArmed)));
}

let timer: NodeJS.Timeout | null = null;
let botRef: Bot | null = null;
let autoRef: ((api: Bot["api"], chatId: string, p: { position: string; pool: string; pair?: string; pool_name?: string }, why: string) => Promise<unknown>) | null = null;
let busy = false;
export const tpslMonitorRunning = () => timer != null;

async function tick(): Promise<void> {
  if (busy || !botRef) return;
  busy = true;
  try {
    const users = usersWithTpsl();
    if (!users.length) return stopMonitor();
    for (const u of users) {
      await runAsUser({ userId: u.id, isOwner: u.isOwner }, () =>
        scanTpsl({
          send: (text, kb) => botRef!.api.sendMessage(u.id, text, { reply_markup: kb }),
          auto: autoRef ? (p, why) => runAsUser({ userId: u.id, isOwner: u.isOwner }, () => autoRef!(botRef!.api, u.id, p, why)) : undefined,
        }),
      ).catch((e) => log("tpsl", `scan ${u.id}: ${(e as Error).message}`, "warn"));
    }
  } finally {
    busy = false;
  }
}
function stopMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  log("tpsl", "monitor stop (tidak ada TP/SL)");
}
/** Start the 15s loop only while some TP/SL exists; stop it otherwise. Call after any change. */
export function syncTpslMonitor(): void {
  if (!botRef) return;
  const any = usersWithTpsl().length > 0;
  if (any && !timer) {
    timer = setInterval(() => void tick(), TPSL_INTERVAL_MS);
    log("tpsl", "monitor start (15s)");
  } else if (!any && timer) stopMonitor();
}
export function startTpslMonitor(bot: Bot, auto?: typeof autoRef): void {
  botRef = bot;
  autoRef = auto ?? null;
  syncTpslMonitor();
}
export { tpslLine };

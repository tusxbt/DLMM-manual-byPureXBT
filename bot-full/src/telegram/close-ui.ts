/**
 * Compact Exit / Zapout UX: one status message edited through stages, a 2–3 line result,
 * and an optional PnL photo that REPLACES the status message (caption = result).
 * Full details only behind ℹ️ Detail (expand/collapse in place).
 */
import { InlineKeyboard, InputFile, type Bot, type Context } from "grammy";
import crypto from "node:crypto";
import { mainMenuKeyboard } from "./menus.js";
import { redactSecrets, log } from "../logger.js";
import { code } from "./html.js";
import { showPositionCards } from "./positions-view.js";
import { buildPnlCardPng, type PositionSnapshot, type RealizedOut } from "./pnl-send.js";

import { currentUser } from "../users/context.js";
import { kv, pnlLine } from "./layout.js";
import { fetchClosedPnl } from "../engine/meteora-pnl.js";
import { loadConfig } from "../config.js";
const details = new Map<string, { short: string; full: string; at: number; uid?: string }>();

function remember(short: string, full: string): string {
  const now = Date.now();
  for (const [k, v] of details) if (now - v.at > 6 * 3600e3) details.delete(k);
  const id = crypto.randomBytes(5).toString("hex");
  details.set(id, { short, full, at: now, uid: currentUser()?.userId });
  return id;
}

export function closeKb(detailId: string, expanded = false): InlineKeyboard {
  return new InlineKeyboard()
    .text(expanded ? "▲ Ringkas" : "ℹ️ Detail", `cl:${expanded ? "less" : "more"}:${detailId}`)
    .text("📊 Positions", "cl:pos")
    .text("🏠", "menu:cancel");
}

export type CloseOutcome = {
  kind: "remove" | "zapout";
  pair: string;
  success: boolean;
  signatures: string[];
  message?: string;
  error?: string;
  ms: number;
  /** realized from close txs (withdrawn + fees + swap), rent refunds & tx fees excluded */
  realized?: RealizedOut | null;
  snapshot?: PositionSnapshot;
};

export function closeTitle(kind: "remove" | "zapout", pair: string): string {
  return kind === "zapout" ? `⚡ Zapout ${pair} → SOL` : `🚪 Exit ${pair}`;
}

/** "+$1.20 (+2.40%) · 0.5509 SOL (tanpa rent)" — rent refunds & tx fees excluded. */
export function realizedText(r: RealizedOut): string {
  const sol = `${r.solNet.toFixed(4)} SOL${Object.keys(r.tokenNet).length ? " + token" : ""}`;
  return `${r.pnlUsd != null ? `${pnlLine(r.pnlUsd, r.pnlPct)} · ` : ""}${sol} (tanpa rent)`;
}

/** 2–3 short lines. Pure for tests. */
export function compactResult(o: CloseOutcome): string {
  const name = o.kind === "zapout" ? `Zapout ${o.pair}` : `Exit ${o.pair}`;
  if (!o.success) {
    const err = redactSecrets(o.error || o.message || "gagal").split("\n")[0].slice(0, 90);
    return `❌ **${name} gagal**\n${err}`;
  }
  const s = o.snapshot;
  const m = s?.meteora && s.meteora.pnlUsd != null ? s.meteora : null;
  let pnl: string;
  let src = "";
  if (m) {
    pnl = pnlLine(m.pnlUsd, m.pnlPct);
  } else if (o.realized?.pnlUsd != null) {
    pnl = pnlLine(o.realized.pnlUsd, o.realized.pnlPct);
    src = "realized, tanpa rent";
  } else {
    const exitUsd = s?.total_value_usd == null ? null : s.total_value_usd + (s.unclaimed_fees_usd ?? 0);
    if (s?.cost_usd && s.cost_usd > 0 && exitUsd != null) {
      const d = exitUsd - s.cost_usd;
      pnl = pnlLine(d, (d / s.cost_usd) * 100);
      src = "estimasi";
    } else pnl = "n/a";
  }
  const real = o.signatures.filter((x) => !x.startsWith("DRY_RUN"));
  const dry = o.signatures.length > 0 && real.length === 0;
  const last = real.at(-1);
  return [
    `✅ **${name}**${dry ? " 🧪" : ""}`,
    kv("PnL", pnl),
    src ? kv("Sumber", src) : null,
    o.realized && !src.startsWith("realized") && o.realized.pnlUsd != null ? kv("Realized", pnlLine(o.realized.pnlUsd, o.realized.pnlPct)) : null,
    o.realized ? kv("Diterima", `${o.realized.solNet.toFixed(4)} SOL${Object.keys(o.realized.tokenNet).length ? " +tkn" : ""}`) : null,
    kv("Waktu", `${(o.ms / 1000).toFixed(1)}s`),
    last ? `[🧾 Tx Solscan](https://solscan.io/tx/${last})${real.length > 1 ? ` +${real.length - 1}` : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function fullDetail(o: CloseOutcome): string {
  return [
    o.message || o.error || "",
    "",
    ...o.signatures.map((x) => (x.startsWith("DRY_RUN") ? code(x) : `${code(x)} [Solscan](https://solscan.io/tx/${x})`)),
  ].join("\n").trim();
}

export async function setStatus(ctx: Context, msgId: number | undefined, text: string): Promise<number> {
  if (msgId) {
    try {
      await ctx.api.editMessageText(ctx.chat!.id, msgId, text);
      return msgId;
    } catch (e) {
      if (/not modified/i.test(String((e as Error).message))) return msgId;
    }
  }
  return (await ctx.reply(text)).message_id;
}

/** Final: photo (if card renders) replacing the status message, else edit status text. */
export async function finishClose(ctx: Context, msgId: number, o: CloseOutcome): Promise<void> {
  // Meteora PnL (same as UI); indexer may lag a few seconds after close
  if (o.success && o.snapshot && !o.signatures.every((x) => x.startsWith("DRY_RUN"))) {
    try {
      await setStatus(ctx, msgId, `⏳ Ambil PnL Meteora…`);
      const wallet = loadConfig({ requireTelegram: false, skipWallet: true }).walletPublicKey.toBase58();
      const m = await fetchClosedPnl(o.snapshot.pool, wallet, o.snapshot.position);
      if (m) o.snapshot = { ...o.snapshot, meteora: m };
    } catch {
      /* fallback: estimasi */
    }
  }
  const short = compactResult(o);
  const id = remember(short, `${short}\n\n${fullDetail(o)}`);
  if (o.success && o.snapshot && !o.signatures.every((x) => x.startsWith("DRY_RUN"))) {
    try {
      const png = await buildPnlCardPng({ ...o.snapshot, exit_label: o.kind === "zapout" ? "ZAPOUT" : "MANUAL EXIT" }, true);
      await ctx.replyWithPhoto(new InputFile(png, "pnl.png"), { caption: short, reply_markup: closeKb(id) });
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, msgId);
      } catch {
        await setStatus(ctx, msgId, short);
      }
      return;
    } catch (e) {
      log("close_ui", `pnl card skipped: ${(e as Error).message}`, "warn");
    }
  }
  try {
    await ctx.api.editMessageText(ctx.chat!.id, msgId, short, { reply_markup: closeKb(id) });
  } catch {
    await ctx.reply(short, { reply_markup: closeKb(id) });
  }
}

export function registerCloseUi(bot: Bot): void {
  bot.callbackQuery("cl:pos", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPositionCards(ctx, { refetch: true, fresh: true }); // keep the result message intact
  });
  bot.callbackQuery(/^cl:(more|less):([a-f0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const d = details.get(ctx.match![2]);
    if (!d || d.uid !== currentUser()?.userId) return;
    const more = ctx.match![1] === "more";
    const text = (more ? d.full : d.short).slice(0, 1000);
    const kb = closeKb(ctx.match![2], more);
    try {
      if (ctx.callbackQuery.message && "photo" in ctx.callbackQuery.message && ctx.callbackQuery.message.photo) {
        await ctx.editMessageCaption({ caption: text, reply_markup: kb });
      } else {
        await ctx.editMessageText(more ? (d.full).slice(0, 3900) : d.short, { reply_markup: kb });
      }
    } catch {
      /* ignore */
    }
  });
}

export { mainMenuKeyboard };

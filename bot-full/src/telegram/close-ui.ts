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
import { fetchClosedPnl, type MeteoraPnl } from "../engine/meteora-pnl.js";
import { loadConfig } from "../config.js";
const details = new Map<string, { short: string; full: string; at: number; uid?: string; leftover?: string[] }>();

function remember(short: string, full: string, leftover?: string[]): string {
  const now = Date.now();
  for (const [k, v] of details) if (now - v.at > 6 * 3600e3) details.delete(k);
  const id = crypto.randomBytes(5).toString("hex");
  details.set(id, { short, full, at: now, uid: currentUser()?.userId, leftover });
  return id;
}

/** 🔁 Retry swap buttons (stateless, no expiry): sells the current wallet balance of the mint → SOL. */
export function retrySwapKb(mints: string[] | undefined, kb = new InlineKeyboard()): InlineKeyboard {
  for (const m of (mints ?? []).slice(0, 3)) kb.text(mints!.length > 1 ? `🔁 Retry swap ${m.slice(0, 4)}…` : "🔁 Retry swap", `sw:retry:${m}`).row();
  return kb;
}

export function closeKb(detailId: string, expanded = false, leftover?: string[]): InlineKeyboard {
  return retrySwapKb(leftover)
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
  /** tokens left in the wallet after a failed swap */
  leftoverMints?: string[];
  /** Meteora closed-PnL fetch started early (in parallel with the realized calc) */
  meteoraP?: Promise<MeteoraPnl | null>;
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
  const r = o.realized;
  if (r?.pnlUsd != null) {
    pnl = pnlLine(r.pnlUsd, r.pnlPct);
    src = "on-chain, tanpa rent";
  } else if (m) {
    pnl = pnlLine(m.pnlUsd, m.pnlPct);
    src = "Meteora";
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
    o.realized?.pnlSol != null && src.startsWith("on-chain") ? kv("PnL SOL", `${o.realized.pnlSol >= 0 ? "+" : "−"}${Math.abs(o.realized.pnlSol).toFixed(4)}`) : null,
    src ? kv("Sumber", src) : null,
    m && src.startsWith("on-chain") ? kv("Meteora", pnlLine(m.pnlUsd, m.pnlPct)) : null,
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
      const m = await (o.meteoraP ?? fetchClosedPnl(o.snapshot.pool, wallet, o.snapshot.position));
      if (m) o.snapshot = { ...o.snapshot, meteora: m };
    } catch {
      /* fallback: estimasi */
    }
  }
  const short = compactResult(o);
  const id = remember(short, `${short}\n\n${fullDetail(o)}`, o.leftoverMints);
  if (o.success && o.snapshot && !o.signatures.every((x) => x.startsWith("DRY_RUN"))) {
    try {
      const png = await buildPnlCardPng({ ...o.snapshot, exit_label: o.kind === "zapout" ? "ZAPOUT" : "MANUAL EXIT" }, true);
      await ctx.replyWithPhoto(new InputFile(png, "pnl.png"), { caption: short, reply_markup: closeKb(id, false, o.leftoverMints) });
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
    await ctx.api.editMessageText(ctx.chat!.id, msgId, short, { reply_markup: closeKb(id, false, o.leftoverMints) });
  } catch {
    await ctx.reply(short, { reply_markup: closeKb(id, false, o.leftoverMints) });
  }
}

const retryLocks = new Set<string>();

/** Text for a 🔁 Retry swap result. Pure for tests. */
export function retrySwapText(r: { success: boolean; soldAtomic: bigint; estOutLamports: bigint; attempts: number; error?: string; signatures: string[] }, mint: string): string {
  const m = `${mint.slice(0, 4)}…`;
  if (r.success && r.soldAtomic === 0n && !r.signatures.length) return `ℹ️ Tidak ada saldo ${m} di wallet — tidak ada yang di-swap.`;
  if (r.success) return `✅ Swap ${m} → SOL OK${r.estOutLamports > 0n ? ` · ≈${(Number(r.estOutLamports) / 1e9).toFixed(6)} SOL` : ""}${r.attempts > 1 ? ` (try ${r.attempts})` : ""}`;
  return `❌ Swap ${m} → SOL gagal ${r.attempts}x: ${String(r.error ?? "").split("\n")[0].slice(0, 300)}\nToken masih di wallet — tap 🔁 lagi.`;
}

export function registerCloseUi(bot: Bot): void {
  // 🔁 Retry swap — no expiry: re-quote and sell the whole current wallet balance of the mint → SOL
  bot.callbackQuery(/^sw:retry:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    const mint = ctx.match![1];
    const lockKey = `${currentUser()?.userId ?? "-"}:${mint}`;
    if (retryLocks.has(lockKey)) return ctx.answerCallbackQuery({ text: "Swap sedang berjalan…" });
    retryLocks.add(lockKey);
    await ctx.answerCallbackQuery({ text: "🔁 Swap ulang…" });
    try {
      if (loadConfig({ requireTelegram: false, skipWallet: true }).dryRun) {
        await ctx.reply(`DRY RUN — swap ulang ${mint.slice(0, 4)}… → SOL tidak dikirim.`);
        return;
      }
      const msg = await ctx.reply(`⏳ Swap ulang ${mint.slice(0, 4)}… → SOL (quote baru, saldo wallet penuh)…`);
      const { retrySwapAll } = await import("../engine/swap-robust.js");
      const r = await retrySwapAll(mint);
      const sigs = r.signatures.map((s) => `https://solscan.io/tx/${s}`).join("\n");
      const text = [retrySwapText(r, mint), sigs].filter(Boolean).join("\n");
      const kb = r.success ? new InlineKeyboard().text("📊 Positions", "cl:pos").text("🏠", "menu:cancel") : retrySwapKb([mint]).text("🏠", "menu:cancel");
      await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, text, { reply_markup: kb }).catch(() => ctx.reply(text, { reply_markup: kb }));
    } catch (e) {
      await ctx.reply(`❌ Swap ulang error: ${(e as Error).message.slice(0, 300)}`, { reply_markup: retrySwapKb([mint]) });
    } finally {
      retryLocks.delete(lockKey);
    }
  });
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
    const kb = closeKb(ctx.match![2], more, d.leftover);
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

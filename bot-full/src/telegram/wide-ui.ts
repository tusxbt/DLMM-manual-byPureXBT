/** Partial wide-deploy recovery: ▶️ resume remaining chunks, or 🚪 Exit (multi-tx remove+close). */
import { InlineKeyboard, type Bot } from "grammy";
import { getTrackedPosition } from "../store/positions.js";
import { buildWideResumeTxs } from "../engine/dlmm-build.js";
import { createConfirm } from "../engine/confirm.js";
import { presentConfirm } from "./confirm-ui.js";
import { loadConfig, CONFIRM_TTL_MS } from "../config.js";
import { snapshotOf } from "./pnl-send.js";

export function partialKb(position: string): InlineKeyboard {
  return new InlineKeyboard().text("▶️ Retry / lanjutkan", `wd:resume:${position}`).text("🚪 Exit", `wd:exit:${position}`);
}

export function registerWideUi(bot: Bot): void {
  bot.callbackQuery(/^wd:resume:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const t = getTrackedPosition(ctx.match![1]); // per-user store → other users' positions are invisible
    if (!t?.partial) {
      await ctx.reply("Tidak ada deploy yang tertunda untuk posisi ini.");
      return;
    }
    const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
    try {
      const msg = await ctx.reply("⏳ Menyusun sisa tx…");
      const txs = await buildWideResumeTxs({
        poolAddress: t.pool,
        positionAddress: t.position,
        minBin: Number(t.min_bin),
        maxBin: Number(t.max_bin),
        strategyKey: t.partial.strategy_key,
        amountXAtomic: t.partial.amount_x_atomic,
        amountYAtomic: t.partial.amount_y_atomic,
        addDone: t.partial.add_done,
        addTotal: t.partial.add_total,
        wide: t.partial.wide !== false && t.partial.add_total > 0,
        mix: t.partial.mix_total
          ? { done: t.partial.mix_done ?? 0, total: t.partial.mix_total, spotX: t.partial.mix_spot_x_atomic ?? "0", spotY: t.partial.mix_spot_y_atomic ?? "0" }
          : undefined,
      });
      if (!txs.length) {
        await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, "Tidak ada tx tersisa.");
        return;
      }
      const summary = [
        `▶️ Lanjutkan deploy **${t.pool_name || t.pool}** · ${txs.length} tx`,
        `Selesai: liquidity ${t.partial.add_done}/${t.partial.add_total}${t.partial.mix_total ? ` · Spot ${t.partial.mix_done ?? 0}/${t.partial.mix_total}` : ""} · distribusi dihitung ulang dari harga sekarang`,
        `${cfg.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"} · konfirmasi ${CONFIRM_TTL_MS / 1000}s`,
      ].join("\n");
      const req = createConfirm({
        purpose: "add",
        summary,
        payload: {
          txs,
          cost_usd: t.cost_usd ?? 0,
          meta: {
            resume: true,
            wide: true,
            position: t.position,
            pool: t.pool,
            pool_name: t.pool_name,
            strategy: t.strategy,
            amount_sol: t.amount_sol,
            min_bin: t.min_bin,
            max_bin: t.max_bin,
            strategy_label: t.strategy_label,
          },
        },
      });
      await presentConfirm(ctx, summary, req.id, { msgId: msg.message_id });
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`, { reply_markup: partialKb(t.position) });
    }
  });

  bot.callbackQuery(/^wd:exit:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const t = getTrackedPosition(ctx.match![1]);
    if (!t) {
      await ctx.reply("Posisi tidak ditemukan.");
      return;
    }
    const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
    const summary = [`🚪 Exit **${t.pool_name || t.pool}** (deploy sebagian)`, `${cfg.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"} · konfirmasi ${CONFIRM_TTL_MS / 1000}s`].join("\n");
    const req = createConfirm({
      purpose: "remove",
      summary,
      payload: {
        pool: t.pool,
        position: t.position,
        pool_name: t.pool_name,
        snapshot: snapshotOf({ ...t, pair: t.pool_name, total_value_usd: null, unclaimed_fees_usd: null } as Record<string, unknown>),
      },
    });
    await presentConfirm(ctx, summary, req.id);
  });
}

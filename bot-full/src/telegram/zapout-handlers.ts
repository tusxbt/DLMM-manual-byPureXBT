import { snapshotOf } from "./pnl-send.js";
import { presentConfirm } from "./confirm-ui.js";
import { InlineKeyboard, type Context } from "grammy";
import { loadConfig, CONFIRM_TTL_MS } from "../config.js";
import { fmtUsd, shortAddr } from "../format.js";
import { getSession, resetSession } from "./session.js";
import { mainMenuKeyboard, confirmKeyboard } from "./menus.js";
import { loadTrackedPositions } from "../store/positions.js";
import { listLivePositions } from "../engine/dlmm-read.js";
import { createConfirm } from "../engine/confirm.js";
import {
  analyzeZapout,
  executeZapout,
  formatZapoutPreview,
} from "../engine/zapout.js";

export { executeZapout };

function chatKey(ctx: Context): string {
  return String(ctx.chat?.id ?? "");
}

export async function startZapout(ctx: Context): Promise<void> {
  resetSession(chatKey(ctx));
  try {
    const tracked = loadTrackedPositions();
    const cost: Record<string, number> = {};
    for (const t of tracked) if (t.cost_usd) cost[t.position] = t.cost_usd;
    const live = await listLivePositions(cost);
    const s = getSession(chatKey(ctx));
    s.data.posList = live.map((p) => {
      const meta = tracked.find((t) => t.position === p.position) || {};
      return { ...meta, ...p };
    });
    if (!live.length) {
      await ctx.reply("Tidak ada posisi untuk zapout.", { reply_markup: mainMenuKeyboard() });
      return;
    }
    const lines = s.data.posList.map((p, i) => {
      return `${i + 1}. ${p.pool_name || shortAddr(String(p.pool))}\n   Nilai ${fmtUsd(Number(p.total_value_usd))} | fees ${fmtUsd(Number(p.unclaimed_fees_usd))}`;
    });
    const kb = new InlineKeyboard();
    s.data.posList.forEach((_, i) => {
      kb.text(`Zapout ${i + 1}`, `zapout:pos:${i}`).row();
    });
    kb.text("❌ Batal", "menu:cancel");
    await ctx.reply(
      ["⚡ Pilih posisi untuk zapout (claim → close → swap token→SOL):", ...lines].join("\n\n"),
      { reply_markup: kb },
    );
  } catch (e) {
    await ctx.reply(`❌ ${(e as Error).message}`, { reply_markup: mainMenuKeyboard() });
  }
}

export async function onZapoutPos(ctx: Context, index: number): Promise<void> {
  const s = getSession(chatKey(ctx));
  const p = s.data.posList?.[index];
  if (!p) {
    await ctx.reply("Daftar kadaluarsa — /zapout lagi.");
    return;
  }
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  try {
    const pair = String((p as Record<string, unknown>).pair || p.pool_name || "posisi").replace(/-/g, "/");
    const statusId = (await ctx.reply(`⏳ Cek ${pair}…`)).message_id;
    const analysis = await analyzeZapout({
      poolAddress: String(p.pool),
      positionAddress: String(p.position),
      poolName: String(p.pool_name || ""),
      totalValueUsd: p.total_value_usd == null ? NaN : Number(p.total_value_usd),
      unclaimedFeesUsd: p.unclaimed_fees_usd == null ? NaN : Number(p.unclaimed_fees_usd),
    });
    const val = Number.isFinite(analysis.totalValueUsd) ? `$${(analysis.totalValueUsd + (Number.isFinite(analysis.unclaimedFeesUsd) ? analysis.unclaimedFeesUsd : 0)).toFixed(2)}` : "n/a";
    const summary = [
      `⚡ Zapout **${pair}** → SOL · ≈${val}`,
      `slip ${analysis.swapSlippagePct}% · ${cfg.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"} · konfirmasi ${CONFIRM_TTL_MS / 1000}s`,
      analysis.overSwapCap ? `⚠️ swap ≈$${analysis.estTokenOutUsd.toFixed(2)} > cap $${analysis.maxSwapUsd} (exit tetap diizinkan)` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const req = createConfirm({
      purpose: "zapout",
      summary,
      payload: {
        pool: analysis.pool,
        position: analysis.position,
        pool_name: analysis.poolName || "",
        analysis,
        snapshot: snapshotOf(p as Record<string, unknown>),
      },
    });
    resetSession(chatKey(ctx));
    await presentConfirm(ctx, summary, req.id, { msgId: statusId });
  } catch (e) {
    await ctx.reply(`❌ ${(e as Error).message}`, { reply_markup: mainMenuKeyboard() });
  }
}


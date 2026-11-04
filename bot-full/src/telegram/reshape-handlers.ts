import { presentConfirm } from "./confirm-ui.js";
import { InlineKeyboard, type Context } from "grammy";
import { loadConfig, CONFIRM_TTL_MS } from "../config.js";
import { fmtUsd, shortAddr } from "../format.js";
import { getSession, resetSession } from "./session.js";
import { mainMenuKeyboard, CANCEL_KB, confirmKeyboard } from "./menus.js";
import { loadTrackedPositions } from "../store/positions.js";
import { listLivePositions } from "../engine/dlmm-read.js";
import { createConfirm } from "../engine/confirm.js";
import { listStrategies, requireStrategy } from "../strategies/index.js";
import {
  analyzeReshape,
  executeReshape,
  formatReshapePreview,
  type ReshapeAnalysis,
} from "../engine/reshape.js";
import { clampReshapeWidth } from "../engine/reshape-math.js";

export { executeReshape };

function chatKey(ctx: Context): string {
  return String(ctx.chat?.id ?? "");
}

export async function startReshape(ctx: Context): Promise<void> {
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
      await ctx.reply("Tidak ada posisi untuk di-reshape.", { reply_markup: mainMenuKeyboard() });
      return;
    }
    const lines = s.data.posList.map((p, i) => {
      return `${i + 1}. ${p.pool_name || shortAddr(String(p.pool))}\n   Nilai ${fmtUsd(Number(p.total_value_usd))} | fees ${fmtUsd(Number(p.unclaimed_fees_usd))}`;
    });
    const kb = new InlineKeyboard();
    s.data.posList.forEach((_, i) => {
      kb.text(`Reshape ${i + 1}`, `reshape:pos:${i}`).row();
    });
    kb.text("❌ Batal", "menu:cancel");
    await ctx.reply(["♻️ Pilih posisi untuk reshape (claim fee + WD token + re-add BidAsk):", ...lines].join("\n\n"), {
      reply_markup: kb,
    });
  } catch (e) {
    await ctx.reply(`❌ ${(e as Error).message}`, { reply_markup: mainMenuKeyboard() });
  }
}

export async function onReshapePos(ctx: Context, index: number): Promise<void> {
  const s = getSession(chatKey(ctx));
  const p = s.data.posList?.[index];
  if (!p) {
    await ctx.reply("Menu lama — buka 📊 Positions lagi.", { reply_markup: new InlineKeyboard().text("📊 Positions", "pv:lref") });
    return;
  }
  try {
    await ctx.reply("⏳ Analisis bin posisi…");
    const analysis = await analyzeReshape({
      poolAddress: String(p.pool),
      positionAddress: String(p.position),
      poolName: String(p.pool_name || ""),
    });
    s.data.reshapeAnalysis = analysis as unknown as Record<string, unknown>;
    s.data.reshapeWidth = analysis.defaultWidth;
    s.data.reshapeStrategyId = "bid_ask";

    const kb = new InlineKeyboard();
    for (const st of listStrategies()) {
      kb.text(st.id === "bid_ask" ? `✅ ${st.label}` : st.label, `reshape:strat:${st.id}`).row();
    }
    kb.text("❌ Batal", "menu:cancel");
    await ctx.reply(
      [
        formatReshapePreview(analysis, analysis.defaultWidth, "bid_ask"),
        "",
        "Pilih strategi re-add (default Bid-Ask):",
      ].join("\n"),
      { reply_markup: kb },
    );
  } catch (e) {
    const msg = (e as Error).message;
    await ctx.reply(`❌ ${msg}`, { reply_markup: mainMenuKeyboard() });
  }
}

export async function onReshapeStrat(ctx: Context, strategyId: string): Promise<void> {
  const s = getSession(chatKey(ctx));
  requireStrategy(strategyId);
  s.data.reshapeStrategyId = strategyId;
  const analysis = s.data.reshapeAnalysis as unknown as ReshapeAnalysis | undefined;
  if (!analysis) {
    await ctx.reply("Sesi kadaluarsa — /reshape lagi.");
    return;
  }
  const def = analysis.defaultWidth;
  const kb = new InlineKeyboard()
    .text(`Default ${def} bin`, `reshape:width:${def}`)
    .row()
    .text("5", "reshape:width:5")
    .text("10", "reshape:width:10")
    .text("20", "reshape:width:20")
    .row()
    .text("✏️ Custom", "reshape:width:custom")
    .text("❌ Batal", "menu:cancel");
  await ctx.editMessageText(
    `Strategi: ${strategyId}\nPilih lebar range di atas active bin (max 69):`,
    { reply_markup: kb },
  );
}

export async function onReshapeWidth(ctx: Context, arg: string): Promise<void> {
  const s = getSession(chatKey(ctx));
  const analysis = s.data.reshapeAnalysis as unknown as ReshapeAnalysis | undefined;
  if (!analysis) {
    await ctx.reply("Sesi kadaluarsa — /reshape lagi.");
    return;
  }
  if (arg === "custom") {
    s.awaitingText = async (text) => {
      const n = Number(String(text).trim());
      if (!Number.isInteger(n) || n < 1) {
        await ctx.reply("Ketik bilangan bulat 1–69:");
        s.awaitingText = s.awaitingText;
        return;
      }
      await finalizeReshapeConfirm(ctx, clampReshapeWidth(n, analysis.defaultWidth));
    };
    await ctx.reply("Ketik lebar bin (1–69):", { reply_markup: CANCEL_KB });
    return;
  }
  const width = clampReshapeWidth(Number(arg), analysis.defaultWidth);
  await finalizeReshapeConfirm(ctx, width);
}

async function finalizeReshapeConfirm(ctx: Context, width: number): Promise<void> {
  const s = getSession(chatKey(ctx));
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const analysis = s.data.reshapeAnalysis as unknown as ReshapeAnalysis | undefined;
  const strategyId = s.data.reshapeStrategyId || "bid_ask";
  if (!analysis) {
    await ctx.reply("Sesi kadaluarsa — /reshape lagi.");
    return;
  }

  const summary = [
    formatReshapePreview(analysis, width, strategyId),
    "",
    "Langkah saat Confirm:",
    "1) Claim swap fee (skip jika 0)",
    "2) Withdraw HANYA bin token (SOL-only tetap)",
    "3) Re-add token+fee token (delta wallet aktual) posisi baru",
    cfg.dryRun ? "Mode: DRY_RUN" : "Mode: LIVE",
    `Konfirmasi dalam ${CONFIRM_TTL_MS / 1000}s.`,
  ].join("\n");

  const req = createConfirm({
    purpose: "reshape",
    summary,
    payload: {
      pool: analysis.pool,
      position: analysis.position,
      pool_name: analysis.poolName || "",
      strategyId,
      width,
      estimated_usd: analysis.estimatedReaddUsd,
      analysis,
    },
  });
  resetSession(chatKey(ctx));
  // Telegram hard limit — truncate if needed
  const text = summary.length > 3500 ? summary.slice(0, 3490) + "\n…" : summary;
  await presentConfirm(ctx, text, req.id);
}


import { Bot, InlineKeyboard, type Context } from "grammy";
import { loadConfig, CONFIRM_TTL_MS } from "../config.js";
import { fmtNum, fmtUsd, shortAddr, strategyLabel, solscanTx } from "../format.js";
import { log, redactSecrets } from "../logger.js";
import { isAuthorized } from "./auth.js";
import { getSession, resetSession } from "./session.js";
import { mainMenuKeyboard, CANCEL_KB, confirmKeyboard } from "./menus.js";
import { loadSettings } from "../store/settings.js";
import { addTrackedPosition, loadTrackedPositions, removeTrackedPosition } from "../store/positions.js";
import { searchPools, listLivePositions, getActiveBin } from "../engine/dlmm-read.js";
import { buildAddLiquidityTxs, buildClaimFeeTxs, buildRemoveAndCloseTxs, binsFromPct } from "../engine/dlmm-build.js";
import { getBalances } from "../engine/connection.js";
import { getSolUsd } from "../engine/prices.js";
import { createConfirm, takeAwaiting, markConfirm, cancelConfirm } from "../engine/confirm.js";
import { assertUsdCap, executePendingTxs } from "../engine/executor.js";
import { listStrategies, requireStrategy } from "../strategies/index.js";
import { getSwapQuote, buildSwapTx, uiAmountToAtomic, normalizeMint } from "../engine/jupiter-swap.js";
import { SOL_MINT, USDC_MINT } from "../config.js";
import type { PendingTxItem } from "../engine/pending.js";
import {
  startReshape,
  onReshapePos,
  onReshapeStrat,
  onReshapeWidth,
  executeReshape,
} from "./reshape-handlers.js";
import { registerAddPanel, registerSettingsPanel, startAdd, showSettings, showPoolPickerForPanel, bottomKeyboard, replyKbAction } from "./panels.js";
import { startZapout, onZapoutPos, executeZapout } from "./zapout-handlers.js";
import { detectMintAddress } from "../engine/mint-detect.js";
import {
  getSwapSlippagePct,
  getLiqSlippagePct,
  setSwapSlippagePct,
  setLiqSlippagePct,
} from "../engine/slippage.js";

function chatKey(ctx: Context): string {
  return String(ctx.chat?.id ?? "");
}

async function replyMenu(ctx: Context, text?: string): Promise<void> {
  resetSession(chatKey(ctx));
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const mode = cfg.dryRun ? "🧪 DRY_RUN (simulasi)" : "⚠️ LIVE (kirim on-chain)";
  await ctx.reply(text || `DLMM Bot Full — ${mode}\nPilih aksi:`, { reply_markup: mainMenuKeyboard() });
}

export function createBot(): Bot {
  const cfg = loadConfig();
  const bot = new Bot(cfg.telegramToken);

  bot.use(async (ctx, next) => {
    if (!ctx.chat) return;
    if (!isAuthorized(ctx)) {
      log("auth", `ignored chat=${ctx.chat.id} from=${ctx.from?.id}`);
      return;
    }
    await next();
  });

  const withBottomBar = async (ctx: Context) => {
    await ctx.reply("⌨️ Menu bawah aktif.", { reply_markup: bottomKeyboard() });
    await replyMenu(ctx);
  };
  bot.command("start", withBottomBar);
  bot.command("menu", withBottomBar);
  bot.command("cancel", async (ctx) => {
    resetSession(chatKey(ctx));
    await ctx.reply("Dibatalkan.");
    await replyMenu(ctx);
  });

  bot.command("balance", async (ctx) => showBalance(ctx));
  bot.command("positions", async (ctx) => showPositions(ctx));
  bot.command("settings", async (ctx) => showSettings(ctx));
  bot.command("pools", async (ctx) => {
    const q = ctx.match?.trim();
    if (!q) {
      const s = getSession(chatKey(ctx));
      s.awaitingText = async (text) => {
        await doPools(ctx, text.trim());
      };
      await ctx.reply("🔍 Kirim mint / query pool:", { reply_markup: CANCEL_KB });
      return;
    }
    await doPools(ctx, q);
  });

  bot.command("add", async (ctx) => startAdd(ctx));
  bot.command("remove", async (ctx) => startRemove(ctx));
  bot.command("claim", async (ctx) => startClaim(ctx));
  bot.command("swap", async (ctx) => startSwap(ctx));
  bot.command("reshape", async (ctx) => startReshape(ctx));
  bot.command("zapout", async (ctx) => startZapout(ctx));

  bot.callbackQuery(/^menu:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = ctx.match![1];
    if (action === "cancel") {
      resetSession(chatKey(ctx));
      await ctx.editMessageText("Dibatalkan.");
      await replyMenu(ctx);
      return;
    }
    const map: Record<string, (c: Context) => Promise<void>> = {
      add: startAdd,
      positions: showPositions,
      claim: startClaim,
      remove: startRemove,
      swap: startSwap,
      reshape: startReshape,
      zapout: startZapout,
      balance: showBalance,
      settings: showSettings,
      pools: async (c) => {
        getSession(chatKey(c)).awaitingText = async (text) => doPools(c, text.trim());
        await c.reply("🔍 Kirim mint / query pool:", { reply_markup: CANCEL_KB });
      },
    };
    const fn = map[action];
    if (fn) await fn(ctx);
  });

  // Confirm / Cancel gate
  bot.callbackQuery(/^confirm:(yes|no):([a-f0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const yes = ctx.match![1] === "yes";
    const id = ctx.match![2];
    const req = takeAwaiting(id);
    if (!req) {
      await ctx.editMessageText("Konfirmasi tidak ditemukan / sudah diproses.");
      return;
    }
    if (req.status === "expired" || Date.now() > req.expiresAt) {
      markConfirm(id, "expired");
      if (req.purpose === "add") {
        await ctx.editMessageText("⏰ Konfirmasi kadaluarsa (60 detik). Panel Add masih ada — tekan 🚀 Deploy lagi.");
        return;
      }
      await ctx.editMessageText("⏰ Konfirmasi kadaluarsa (batas 60 detik). Ulangi perintah.");
      await replyMenu(ctx);
      return;
    }
    if (!yes) {
      cancelConfirm(id);
      if (req.purpose === "add") {
        await ctx.editMessageText("❌ Dibatalkan. Tidak ada transaksi dikirim. Panel Add di atas masih bisa diedit.");
        return;
      }
      await ctx.editMessageText("❌ Dibatalkan. Tidak ada transaksi dikirim.");
      await replyMenu(ctx);
      return;
    }
    await ctx.editMessageText(`⏳ Menjalankan ${req.purpose}${cfg.dryRun ? " (DRY_RUN)" : ""}…`);
    try {
      const result = await runConfirmedAction(req.purpose, req.payload);
      markConfirm(id, result.success ? "executed" : "failed", result.message);
      const sigLines = (result.signatures || [])
        .map((s) => (s.startsWith("DRY_RUN") ? s : solscanTx(s)))
        .join("\n");
      await ctx.reply(
        [
          result.success ? `✅ ${req.purpose} OK` : `❌ ${req.purpose} gagal`,
          result.message || result.error || "",
          sigLines ? `Sig:\n${sigLines}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        { reply_markup: mainMenuKeyboard() },
      );
    } catch (e) {
      markConfirm(id, "failed", (e as Error).message);
      await ctx.reply(`❌ ${redactSecrets((e as Error).message)}`, { reply_markup: mainMenuKeyboard() });
    }
    resetSession(chatKey(ctx));
  });

  registerAddPanel(bot);
  registerSettingsPanel(bot);

  // claim / remove index callbacks
  bot.callbackQuery(/^pos:(claim|remove):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const kind = ctx.match![1] as "claim" | "remove";
    const i = Number(ctx.match![2]);
    const s = getSession(chatKey(ctx));
    const p = s.data.posList?.[i];
    if (!p) return void (await ctx.reply("Daftar kadaluarsa — /positions dulu."));
    try {
      const summary = [
        kind === "claim" ? "Claim fees" : "Remove 100% + close",
        `Pool: ${p.pool_name || shortAddr(String(p.pool))}`,
        `Pos: ${shortAddr(String(p.position))}`,
        `Nilai ${fmtUsd(Number(p.total_value_usd))} | fees ${fmtUsd(Number(p.unclaimed_fees_usd))}`,
        cfg.dryRun ? "Mode: DRY_RUN" : "Mode: LIVE",
        `Konfirmasi dalam ${CONFIRM_TTL_MS / 1000}s.`,
      ].join("\n");
      const req = createConfirm({
        purpose: kind,
        summary,
        payload: {
          pool: String(p.pool),
          position: String(p.position),
          pool_name: p.pool_name,
        },
      });
      await ctx.editMessageText(`${summary}\n\nid=${req.id}`, { reply_markup: confirmKeyboard(req.id) });
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`);
    }
  });

  // swap callbacks
  bot.callbackQuery(/^swap:pair:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const pair = ctx.match![1];
    const s = getSession(chatKey(ctx));
    if (pair === "sol_usdc") {
      s.data.swapInputMint = SOL_MINT;
      s.data.swapOutputMint = USDC_MINT;
    } else if (pair === "usdc_sol") {
      s.data.swapInputMint = USDC_MINT;
      s.data.swapOutputMint = SOL_MINT;
    } else if (pair === "custom") {
      s.awaitingText = async (text) => {
        const [a, b] = text.trim().split(/\s+/);
        if (!a || !b) {
          await ctx.reply("Format: <inputMint> <outputMint>");
          return;
        }
        s.data.swapInputMint = normalizeMint(a);
        s.data.swapOutputMint = normalizeMint(b);
        s.awaitingText = async (amt) => {
          await finishSwapAmount(ctx, amt);
        };
        await ctx.reply("Ketik amount (UI) untuk input mint:");
      };
      await ctx.reply("Ketik: <inputMint> <outputMint>");
      return;
    }
    s.awaitingText = async (amt) => finishSwapAmount(ctx, amt);
    await ctx.reply("Ketik amount (UI) yang akan di-swap:");
  });


  // reshape callbacks
  bot.callbackQuery(/^reshape:pos:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await onReshapePos(ctx, Number(ctx.match![1]));
  });
  bot.callbackQuery(/^reshape:strat:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await onReshapeStrat(ctx, ctx.match![1]);
  });
  bot.callbackQuery(/^reshape:width:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await onReshapeWidth(ctx, ctx.match![1]);
  });

  bot.callbackQuery(/^zapout:pos:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await onZapoutPos(ctx, Number(ctx.match![1]));
  });

  bot.on("message:text", async (ctx) => {
    const s = getSession(chatKey(ctx));
    const kbAction = replyKbAction(ctx.message.text);
    if (kbAction) {
      s.awaitingText = null;
      if (kbAction === "home") return replyMenu(ctx);
      if (kbAction === "positions") return showPositions(ctx);
      if (kbAction === "trade") return startSwap(ctx);
      if (kbAction === "wallet") return showBalance(ctx);
      return showSettings(ctx);
    }
    if (s.awaitingText) {
      const fn = s.awaitingText;
      s.awaitingText = null;
      await fn(ctx.message.text);
      return;
    }
    const t = ctx.message.text.trim();
    const mint = detectMintAddress(t);
    if (mint) {
      resetSession(chatKey(ctx)); // fresh panel message for each CA paste
      await doPools(ctx, mint, true); // paste CA → list pools → add wizard
      return;
    }
    await replyMenu(ctx);
  });

  bot.catch((err) => {
    log("bot", redactSecrets(String(err.error || err)), "error");
  });

  return bot;
}

async function runConfirmedAction(
  purpose: string,
  payload: Record<string, unknown>,
): Promise<{ success: boolean; signatures?: string[]; message?: string; error?: string }> {
  if (purpose === "add") {
    const txs = payload.txs as PendingTxItem[];
    const meta = (payload.meta || {}) as Record<string, unknown>;
    const costUsd = Number(payload.cost_usd || 0);
    assertUsdCap("position", costUsd);
    const result = await executePendingTxs(txs);
    if (result.success && !result.dryRun) {
      addTrackedPosition({
        position: String(meta.position),
        pool: String(meta.pool),
        pool_name: String(meta.pool_name || ""),
        strategy: String(meta.strategy || ""),
        amount_sol: Number(meta.amount_sol || 0),
        min_bin: Number(meta.min_bin || 0),
        max_bin: Number(meta.max_bin || 0),
        opened_at: new Date().toISOString(),
        cost_usd: costUsd,
      });
    } else if (result.success && result.dryRun) {
      addTrackedPosition({
        position: String(meta.position),
        pool: String(meta.pool),
        pool_name: String(meta.pool_name || ""),
        strategy: String(meta.strategy || ""),
        amount_sol: Number(meta.amount_sol || 0),
        min_bin: Number(meta.min_bin || 0),
        max_bin: Number(meta.max_bin || 0),
        opened_at: new Date().toISOString(),
        cost_usd: costUsd,
      });
    }
    return {
      success: result.success,
      signatures: result.signatures,
      message: result.message || (result.success ? `Position ${shortAddr(String(meta.position))}` : result.error),
      error: result.error,
    };
  }

  if (purpose === "claim" || purpose === "remove") {
    const pool = String(payload.pool);
    const position = String(payload.position);
    const txs =
      purpose === "claim"
        ? await buildClaimFeeTxs({ poolAddress: pool, positionAddress: position })
        : await buildRemoveAndCloseTxs({ poolAddress: pool, positionAddress: position });
    const result = await executePendingTxs(txs);
    if (purpose === "remove" && result.success) {
      removeTrackedPosition(position);
    }
    return {
      success: result.success,
      signatures: result.signatures,
      message: result.message || result.error,
      error: result.error,
    };
  }

  if (purpose === "swap") {
    const usd = Number(payload.usd_estimate || 0);
    assertUsdCap("swap", usd);
    const txs = payload.txs as PendingTxItem[];
    const result = await executePendingTxs(txs);
    return {
      success: result.success,
      signatures: result.signatures,
      message: result.message || `in=${payload.inAmount} out≈${payload.outAmount}`,
      error: result.error,
    };
  }

  if (purpose === "reshape") {
    assertUsdCap("position", Number(payload.estimated_usd || 0));
    const result = await executeReshape({
      poolAddress: String(payload.pool),
      positionAddress: String(payload.position),
      poolName: String(payload.pool_name || ""),
      strategyId: String(payload.strategyId || "bid_ask"),
      width: Number(payload.width || 0) || undefined,
      analysis: payload.analysis as never,
    });
    return {
      success: result.success,
      signatures: result.signatures,
      message: result.message,
      error: result.error,
    };
  }

  if (purpose === "zapout") {
    const result = await executeZapout({
      poolAddress: String(payload.pool),
      positionAddress: String(payload.position),
      poolName: String(payload.pool_name || ""),
      analysis: payload.analysis as never,
    });
    return {
      success: result.success,
      signatures: result.signatures,
      message: result.message,
      error: result.error,
    };
  }

  return { success: false, error: `purpose tidak dikenal: ${purpose}` };
}

async function doPools(ctx: Context, query: string, forAdd = false): Promise<void> {
  try {
    const pools = await searchPools(query, 8);
    if (!pools.length) {
      await ctx.reply(
        `Tidak ada pool DLMM untuk “${query}”. Coba mint lain atau /pools.`,
        { reply_markup: mainMenuKeyboard() },
      );
      return;
    }
    const s = getSession(chatKey(ctx));
    s.data.pools = pools as unknown as Array<Record<string, unknown>>;
    if (forAdd) {
      await showPoolPickerForPanel(ctx, pools as unknown as Array<Record<string, unknown>>);
      return;
    }
    const lines = pools.map(
      (p, i) =>
        `${i + 1}. ${p.name}\n   ${shortAddr(p.pool)} | step ${p.bin_step} | fee ${fmtNum(p.fee_pct, 2)}% | TVL ${fmtUsd(p.tvl)}`,
    );
    await ctx.reply([`🔍 Pools untuk “${query}”:`, ...lines].join("\n\n"), {
      reply_markup: mainMenuKeyboard(),
    });
  } catch (e) {
    await ctx.reply(`❌ ${(e as Error).message}`);
  }
}

async function showPositions(ctx: Context): Promise<void> {
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
      await ctx.reply("Tidak ada posisi terbuka on-chain untuk wallet ini.", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }
    const lines = s.data.posList.map((p, i) => {
      const ir = p.in_range == null ? "?" : p.in_range ? "🟢 in" : "🔴 OUT";
      return `${i + 1}. ${p.pool_name || shortAddr(String(p.pool))}\n   Nilai ${fmtUsd(Number(p.total_value_usd))} | PnL ${fmtUsd(Number(p.pnl_usd))} (${fmtNum(Number(p.pnl_pct), 2)}%)\n   Fees ${fmtUsd(Number(p.unclaimed_fees_usd))} | ${ir}`;
    });
    const kb = new InlineKeyboard();
    s.data.posList.forEach((_, i) => {
      kb.text(`Claim ${i + 1}`, `pos:claim:${i}`).text(`Remove ${i + 1}`, `pos:remove:${i}`).row();
      kb.text(`Reshape ${i + 1}`, `reshape:pos:${i}`).text(`Zapout ${i + 1}`, `zapout:pos:${i}`).row();
    });
    kb.text("⬅️ Menu", "menu:cancel");
    await ctx.reply(["📊 Positions:", ...lines].join("\n\n"), { reply_markup: kb });
  } catch (e) {
    await ctx.reply(`❌ ${(e as Error).message}`, { reply_markup: mainMenuKeyboard() });
  }
}

async function startClaim(ctx: Context): Promise<void> {
  await showPositions(ctx);
  await ctx.reply("Pilih tombol Claim di atas, lalu Confirm.");
}

async function startRemove(ctx: Context): Promise<void> {
  await showPositions(ctx);
  await ctx.reply("Pilih tombol Remove di atas, lalu Confirm. (Auto-swap tidak aktif — pakai /swap setelah remove.)");
}

async function showBalance(ctx: Context): Promise<void> {
  const solUsd = await getSolUsd();
  const b = await getBalances(solUsd);
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  await ctx.reply(
    [
      `💰 Wallet ${shortAddr(b.wallet)}`,
      `SOL: ${fmtNum(b.sol)} (${fmtUsd(b.sol_usd)})`,
      `USDC: ${fmtNum(b.usdc)} (${fmtUsd(b.usdc_usd)})`,
      `Total ≈ ${fmtUsd(b.total_usd)}`,
      `Mode: ${cfg.dryRun ? "DRY_RUN" : "LIVE"} | cap pos ${fmtUsd(cfg.maxPositionUsd)} / swap ${fmtUsd(cfg.maxSwapUsd)}`,
      b.error ? `⚠️ ${b.error}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    { reply_markup: mainMenuKeyboard() },
  );
}

async function startSwap(ctx: Context): Promise<void> {
  resetSession(chatKey(ctx));
  const kb = new InlineKeyboard()
    .text("SOL → USDC", "swap:pair:sol_usdc")
    .text("USDC → SOL", "swap:pair:usdc_sol")
    .row()
    .text("Custom mints", "swap:pair:custom")
    .text("❌ Batal", "menu:cancel");
  await ctx.reply("🔄 Swap via Jupiter — butuh Confirm sebelum kirim.", { reply_markup: kb });
}

async function finishSwapAmount(ctx: Context, amtText: string): Promise<void> {
  const s = getSession(chatKey(ctx));
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const amt = Number(String(amtText).replace(",", "."));
  if (!Number.isFinite(amt) || amt <= 0) {
    await ctx.reply("Amount tidak valid.");
    return;
  }
  try {
    await ctx.reply("⏳ Quote Jupiter…");
    const inputMint = String(s.data.swapInputMint);
    const atomic = await uiAmountToAtomic(inputMint, amt);
    const quote = await getSwapQuote({
      inputMint,
      outputMint: String(s.data.swapOutputMint),
      amountAtomic: atomic,
    });
    const tx = await buildSwapTx({ quote });

    let usdEstimate = 0;
    if (inputMint === SOL_MINT || inputMint === "SOL") {
      usdEstimate = amt * (await getSolUsd());
    } else if (inputMint === USDC_MINT) {
      usdEstimate = amt;
    } else {
      // conservative: use SOL price * amt as rough upper bound only if tiny; else require USDC/SOL pairs for cap
      usdEstimate = amt; // treat UI amount as USD-ish fallback; user should use SOL/USDC
    }
    assertUsdCap("swap", usdEstimate);

    const summary = [
      "Konfirmasi Swap:",
      `${shortAddr(quote.inputMint)} → ${shortAddr(quote.outputMint)}`,
      `UI in: ${fmtNum(amt)} | atomic in: ${quote.inAmount}`,
      `Est out: ${quote.outAmount}`,
      `Est USD: ${fmtUsd(usdEstimate)} (cap ${fmtUsd(cfg.maxSwapUsd)})`,
      cfg.dryRun ? "Mode: DRY_RUN" : "Mode: LIVE",
      `Konfirmasi dalam ${CONFIRM_TTL_MS / 1000}s.`,
    ].join("\n");

    const req = createConfirm({
      purpose: "swap",
      summary,
      payload: {
        txs: [tx],
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        usd_estimate: usdEstimate,
      },
    });
    resetSession(chatKey(ctx));
    await ctx.reply(summary, { reply_markup: confirmKeyboard(req.id) });
  } catch (e) {
    await ctx.reply(`❌ Swap gagal: ${(e as Error).message}`, { reply_markup: mainMenuKeyboard() });
  }
}

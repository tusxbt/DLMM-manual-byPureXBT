import { realizedFromFlows, realizedUsd, fetchFlows } from "../engine/realized.js";
import type { RealizedOut } from "./pnl-send.js";
import { registerPnlBgUi } from "./pnl-bg.js";
import { poolBlock } from "./pool-format.js";
import { presentConfirm, setConfirmRunner } from "./confirm-ui.js";
import type { ConfirmRequest } from "../engine/confirm.js";
import { Bot, InlineKeyboard, type Context } from "grammy";
import { loadConfig, CONFIRM_TTL_MS } from "../config.js";
import { fmtNum, fmtUsd, shortAddr, strategyLabel } from "../format.js";
import { installHtml, sigLine } from "./html.js";
import { type PositionSnapshot } from "./pnl-send.js";
import { setStatus, finishClose, closeTitle, registerCloseUi, type CloseOutcome } from "./close-ui.js";
import { log, redactSecrets } from "../logger.js";
import { roleFor } from "./auth.js";
import { runAsUser, currentUser } from "../users/context.js";
import { hasWallet } from "../users/store.js";
import { registerUsersUi, showWallet, allowedWithoutWallet, buildWithdrawTx, ONBOARD_TEXT, onboardKb } from "./users-ui.js";
import { PublicKey } from "@solana/web3.js";
import { askPrompt, runAwaitingInput, RETRY, getSession, resetSession } from "./session.js";
import { mainMenuKeyboard, CANCEL_KB, confirmKeyboard, addBackKeyboard } from "./menus.js";
import { loadSettings } from "../store/settings.js";
import { addTrackedPosition, loadTrackedPositions, removeTrackedPosition, upsertTrackedPosition, getTrackedPosition } from "../store/positions.js";
import { partialKb, registerWideUi } from "./wide-ui.js";
import { searchPools, listLivePositions, getActiveBin } from "../engine/dlmm-read.js";
import { buildAddLiquidityTxs, buildClaimFeeTxs, buildRemoveAndCloseTxs, binsFromPct } from "../engine/dlmm-build.js";
import { getBalances } from "../engine/connection.js";
import { getSolUsd, getUsdPrices } from "../engine/prices.js";
import { createConfirm, takeAwaiting, markConfirm, cancelConfirm, renewConfirm, expiredAction } from "../engine/confirm.js";
import { resolvePosition, clearCardsCache, showFlipPreview } from "./positions-view.js";
import { executeFlip } from "../engine/flip.js";
import { registerTpslUi } from "./tpsl-ui.js";
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
import { registerPositionsView, showPositionCards } from "./positions-view.js";
import { openRepositionPanel } from "./panels.js";
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
  const mode = cfg.dryRun ? "🧪 DRY_RUN (simulasi)" : "⚠️ LIVE (on-chain)";
  await ctx.reply(text || `🏠 **DLMM Bot**\n${mode}\n\nPaste CA token untuk buka posisi, atau pilih aksi:`, {
    reply_markup: mainMenuKeyboard(),
  });
}

export function createBot(): Bot {
  const cfg = loadConfig();
  const bot = new Bot(cfg.telegramToken);
  installHtml(bot); // all messages → HTML, `code` = tap-to-copy

  bot.use(async (ctx, next) => {
    if (!ctx.chat) return;
    const role = roleFor(ctx);
    if (!role) {
      log("auth", `denied chat=${ctx.chat.id} from=${ctx.from?.id}`);
      if (ctx.chat.type === "private") await ctx.reply("⛔ akses ditolak").catch(() => undefined);
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }
    const uid = String(ctx.from!.id);
    // every handler below runs scoped to this user: own wallet, data dir, session, confirms
    await runAsUser({ userId: uid, isOwner: role === "owner" }, async () => {
      if (role !== "owner" && !hasWallet(uid) && !allowedWithoutWallet(ctx)) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
        await showWallet(ctx);
        return;
      }
      await next();
    });
  });
  registerUsersUi(bot);
  registerWideUi(bot);

  const withBottomBar = async (ctx: Context) => {
    const me = currentUser();
    if (me && !me.isOwner && !hasWallet(me.userId)) {
      await ctx.reply("⌨️ Menu bawah aktif.", { reply_markup: bottomKeyboard() });
      await ctx.reply(ONBOARD_TEXT, { reply_markup: onboardKb() });
      return;
    }
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

  bot.command("balance", async (ctx) => showWallet(ctx));
  bot.command("positions", async (ctx) => showPositionCards(ctx));
  bot.command("settings", async (ctx) => showSettings(ctx));
  bot.command("pools", async (ctx) => {
    const q = ctx.match?.trim();
    if (!q) {
      const s = getSession(chatKey(ctx));
      s.awaitingText = async (text) => {
        await doPools(ctx, text.trim());
      };
      await askPrompt(ctx, chatKey(ctx), "🔍 Kirim mint / query pool:", { reply_markup: CANCEL_KB });
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
      positions: showPositionCards,
      claim: startClaim,
      remove: startRemove,
      swap: startSwap,
      reshape: startReshape,
      zapout: startZapout,
      balance: showWallet,
      settings: showSettings,
      pools: async (c) => {
        getSession(chatKey(c)).awaitingText = async (text) => doPools(c, text.trim());
        await askPrompt(c, chatKey(c), "🔍 Kirim mint / query pool:", { reply_markup: CANCEL_KB });
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
      await ctx.editMessageText("Konfirmasi lama / sudah diproses — buka 📊 Positions lagi.", {
        reply_markup: new InlineKeyboard().text("📊 Positions", "pv:lref"),
      });
      return;
    }
    if (req.status === "expired" || Date.now() > req.expiresAt) {
      markConfirm(id, "expired");
      if (!yes) {
        await ctx.editMessageText("❌ Dibatalkan.", req.purpose === "add" ? { reply_markup: addBackKeyboard() } : {});
        return;
      }
      const fresh = expiredAction(req);
      if (fresh.kind === "add") {
        await ctx.editMessageText("⏰ Waktu habis — harga bisa berubah. Preview lagi atau Kembali ke setup.", {
          reply_markup: addBackKeyboard(),
        });
        return;
      }
      if (fresh.kind === "zapout") {
        // re-analyze with fresh amounts, then a new confirm
        const r = await resolvePosition(ctx, fresh.position).catch(() => null);
        if (!r) return void (await ctx.editMessageText("Posisi sudah tertutup."));
        await ctx.editMessageText("⏰ Waktu habis — menyiapkan konfirmasi baru…");
        return onZapoutPos(ctx, r.index);
      }
      if (fresh.kind === "flip") {
        const r = await resolvePosition(ctx, fresh.position).catch(() => null);
        if (!r) return void (await ctx.editMessageText("Posisi sudah tertutup."));
        return showFlipPreview(ctx, r.p);
      }
      if (fresh.kind === "renew") {
        const n = renewConfirm(req);
        await ctx.editMessageText("⏰ Waktu habis — konfirmasi baru ⬇️");
        await presentConfirm(ctx, n.summary, n.id);
        return;
      }
      await ctx.editMessageText("⏰ Konfirmasi kadaluarsa (60 detik). Ulangi perintah.");
      await replyMenu(ctx);
      return;
    }
    if (!yes) {
      cancelConfirm(id);
      if (req.purpose === "add") {
        await ctx.editMessageText("❌ Dibatalkan. Tidak ada transaksi dikirim.", { reply_markup: addBackKeyboard() });
        return;
      }
      await ctx.editMessageText("❌ Dibatalkan. Tidak ada transaksi dikirim.");
      await replyMenu(ctx);
      return;
    }
    if (req.purpose === "remove" || req.purpose === "zapout") {
      // compact close: the confirm message itself becomes the status message
      await executeConfirmed(ctx, req, ctx.callbackQuery.message?.message_id);
      return;
    }
    await ctx.editMessageText(`⏳ Menjalankan ${req.purpose}${cfg.dryRun ? " (DRY_RUN)" : ""}…`);
    await executeConfirmed(ctx, req);
  });

  setConfirmRunner(executeConfirmed);

  registerAddPanel(bot);
  registerPositionsView(bot);
  registerTpslUi(bot);
  registerCloseUi(bot);
  registerSettingsPanel(bot);
  registerPnlBgUi(bot, cfg.telegramToken);

  // claim / remove index callbacks
  bot.callbackQuery(/^pos:(claim|remove):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const kind = ctx.match![1] as "claim" | "remove";
    const i = Number(ctx.match![2]);
    const s = getSession(chatKey(ctx));
    const p = s.data.posList?.[i];
    if (!p) return void (await ctx.reply("Menu lama — buka 📊 Positions lagi.", { reply_markup: new InlineKeyboard().text("📊 Positions", "pv:lref") }));
    try {
      const summary = [
        kind === "claim" ? "Claim fees" : "Remove 100% + close",
        `Pool: ${p.pool_name || shortAddr(String(p.pool))}`,
        `Pos: \`${String(p.position)}\``,
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
      await presentConfirm(ctx, `${summary}\n\nid=${req.id}`, req.id, { edit: true });
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
          await askPrompt(ctx, chatKey(ctx), "Format: <inputMint> <outputMint>");
          return RETRY;
        }
        s.data.swapInputMint = normalizeMint(a);
        s.data.swapOutputMint = normalizeMint(b);
        s.awaitingText = async (amt) => {
          await finishSwapAmount(ctx, amt);
        };
        await askPrompt(ctx, chatKey(ctx), "Ketik amount (UI) untuk input mint:");
      };
      await askPrompt(ctx, chatKey(ctx), "Ketik: <inputMint> <outputMint>");
      return;
    }
    s.awaitingText = async (amt) => finishSwapAmount(ctx, amt);
    await askPrompt(ctx, chatKey(ctx), "Ketik amount (UI) yang akan di-swap:");
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
      if (kbAction === "positions") return showPositionCards(ctx);
      if (kbAction === "trade") return startSwap(ctx);
      if (kbAction === "wallet") return showWallet(ctx);
      return showSettings(ctx);
    }
    // typed answer to a pending prompt: handled + user msg & prompt deleted (not a menu reset)
    if (await runAwaitingInput(chatKey(ctx), ctx.message.text, ctx.api, ctx.chat.id, ctx.message.message_id)) return;
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


const PURPOSE_LABEL: Record<string, string> = {
  add: "🚀 Deploy",
  remove: "🚪 Exit",
  withdraw: "📤 Withdraw",
  claim: "💰 Claim",
  swap: "💱 Swap",
  reshape: "🆕 Reshape",
  flip: "🔀 Flip",
  zapout: "⚡ Zapout",
};

/** Realized from the close txs (withdrawn + fees + swap output), excluding rent refunds & tx fees. */
async function computeRealized(sigs: string[], snap?: PositionSnapshot): Promise<RealizedOut | null> {
  const real = sigs.filter((x) => !x.startsWith("DRY_RUN"));
  if (!real.length) return null;
  const wallet = loadConfig({ requireTelegram: false, skipWallet: true }).walletPublicKey.toBase58();
  const r = realizedFromFlows(await fetchFlows(real), wallet);
  let solUsd: number | null = null;
  try {
    solUsd = await getSolUsd();
  } catch {
    solUsd = null;
  }
  const mints = Object.keys(r.tokenNet);
  const prices = mints.length ? await getUsdPrices(mints).catch(() => ({}) as Record<string, number>) : {};
  const deposit = snap?.meteora?.depositUsd ?? (snap?.cost_usd && snap.cost_usd > 0 ? snap.cost_usd : null);
  return { ...r, ...realizedUsd(r, solUsd, prices, deposit) };
}

async function runClose(ctx: Context, req: ConfirmRequest, statusMsgId?: number): Promise<void> {
  const id = req.id;
  const kind = req.purpose as "remove" | "zapout";
  const snap = (req.payload as Record<string, unknown>).snapshot as PositionSnapshot | undefined;
  const pair = snap?.pair || String(req.payload.pool_name || "").replace(/-/g, "/") || "posisi";
  const t0 = Date.now();
  let msgId = await setStatus(ctx, statusMsgId, `⏳ ${closeTitle(kind, pair)}…`);
  let outcome: CloseOutcome;
  try {
    const result = await runConfirmedAction(req.purpose, req.payload, {
      onStage: async (st) => {
        if (st === "swap") msgId = await setStatus(ctx, msgId, `⏳ Swap ${pair} ke SOL…`);
      },
      onProgress: async (d, n) => {
        msgId = await setStatus(ctx, msgId, `⏳ ${closeTitle(kind, pair)}… ${d}/${n} tx`);
      },
    });
    markConfirm(id, result.success ? "executed" : "failed", result.message);
    const ms = Date.now() - t0;
    const realized = result.success ? await computeRealized(result.signatures || [], snap).catch(() => null) : null;
    outcome = { kind, pair, success: result.success, signatures: result.signatures || [], message: result.message, error: result.error, ms, realized, snapshot: snap ? { ...snap, realized } : snap };
    if (result.success && kind === "remove") removeTrackedPosition(String(req.payload.position));
  } catch (e) {
    markConfirm(id, "failed", (e as Error).message);
    outcome = { kind, pair, success: false, signatures: [], error: (e as Error).message, ms: Date.now() - t0, snapshot: snap };
  }
  await finishClose(ctx, msgId, outcome);
  const repo = (req.payload as Record<string, unknown>).reposition as { bins?: number } | undefined;
  resetSession(chatKey(ctx));
  if (outcome.success && kind === "remove" && repo) {
    await openRepositionPanel(ctx, String(req.payload.pool), Number(repo.bins || 40));
  }
}

/** Result replaces the status/preview message in place (falls back to a new message). */
async function editOrSend(ctx: Context, msgId: number | undefined, text: string, kb: InlineKeyboard): Promise<void> {
  if (msgId) {
    try {
      await ctx.api.editMessageText(ctx.chat!.id, msgId, text, { reply_markup: kb, link_preview_options: { is_disabled: true } });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { reply_markup: kb });
}

async function executeConfirmed(ctx: Context, req: ConfirmRequest, statusMsgId?: number): Promise<void> {
  const id = req.id;
  markConfirm(id, "confirmed"); // prevents double execution (double tap / auto + tap)
  clearCardsCache(); // positions change after any action
  if (req.purpose === "remove" || req.purpose === "zapout") return runClose(ctx, req, statusMsgId);
    let progMsg = statusMsgId ?? ctx.callbackQuery?.message?.message_id;
    try {
      const result = await runConfirmedAction(req.purpose, req.payload, {
        onProgress: async (d, n) => {
          progMsg = await setStatus(ctx, progMsg, `⏳ ${PURPOSE_LABEL[req.purpose] ?? req.purpose}… ${d}/${n} tx`);
        },
      });
      markConfirm(id, result.success ? "executed" : "failed", result.message);
      const sigLines = (result.signatures || [])
        .map((s) => sigLine(s))
        .join("\n");
      const text = [
        result.success ? `✅ **${PURPOSE_LABEL[req.purpose] ?? req.purpose} berhasil**` : `❌ **${PURPOSE_LABEL[req.purpose] ?? req.purpose} gagal**`,
        "",
        result.message || result.error || "",
        sigLines ? `\n🧾 Tx:\n${sigLines}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await editOrSend(ctx, progMsg, text, result.keyboard ?? mainMenuKeyboard());
    } catch (e) {
      markConfirm(id, "failed", (e as Error).message);
      await editOrSend(ctx, progMsg, `❌ ${redactSecrets((e as Error).message)}`, mainMenuKeyboard());
    }
    resetSession(chatKey(ctx));
}

async function runConfirmedAction(
  purpose: string,
  payload: Record<string, unknown>,
  hooks: {
    onStage?: (stage: "close" | "swap") => void | Promise<void>;
    onProgress?: (done: number, total: number, label: string) => void | Promise<void>;
  } = {},
): Promise<{ success: boolean; signatures?: string[]; message?: string; error?: string; keyboard?: InlineKeyboard }> {
  if (purpose === "add") {
    const txs = payload.txs as PendingTxItem[];
    const meta = (payload.meta || {}) as Record<string, unknown>;
    const costUsd = Number(payload.cost_usd || 0);
    const result = await executePendingTxs(txs, [], { onProgress: hooks.onProgress });
    const posAddr = String(meta.position);
    const prev = meta.resume ? getTrackedPosition(posAddr) : undefined;
    const base = {
      position: posAddr,
      pool: String(meta.pool),
      pool_name: String(meta.pool_name || ""),
      strategy: String(meta.strategy || ""),
      amount_sol: Number(meta.amount_sol || 0),
      min_bin: Number(meta.min_bin || 0),
      max_bin: Number(meta.max_bin || 0),
      opened_at: prev?.opened_at || new Date().toISOString(),
      cost_usd: prev?.cost_usd ?? costUsd,
      entry_price: prev?.entry_price ?? (Number(meta.entry_price) || undefined),
      strategy_label: (meta.strategy_label as string | undefined) ?? prev?.strategy_label,
    };
    if (result.success) {
      upsertTrackedPosition(base); // clears any partial state
      return {
        success: true,
        signatures: result.signatures,
        message: result.message || `📍 Posisi \`${posAddr}\`${meta.wide ? ` · ${base.max_bin - base.min_bin + 1} bins` : ""}`,
      };
    }
    const landed = result.landedLabels || [];
    const positionExists = !!meta.resume || landed.includes("createPos_1") || landed.includes("initializePositionAndAddLiquidity");
    const multi = !!(meta.wide || meta.mix_pct || prev?.partial);
    if (multi && positionExists && !result.dryRun) {
      const pp = prev?.partial;
      const isWide = !!(meta.wide ?? pp?.wide);
      const addTotal = Number(pp?.add_total ?? meta.add_tx_count ?? 0);
      const addDone = Math.min(addTotal, Number(pp?.add_done ?? 0) + landed.filter((l) => l.startsWith("addChunk")).length);
      const mixTotal = Number(pp?.mix_total ?? meta.mix_spot_tx_count ?? 0);
      const mixDone = Math.min(mixTotal, Number(pp?.mix_done ?? 0) + landed.filter((l) => l.startsWith("mixSpot")).length);
      const partial = {
        wide: isWide,
        add_done: isWide ? addDone : 0,
        add_total: isWide ? addTotal : 0,
        amount_x_atomic: String(meta.amount_x_atomic ?? pp?.amount_x_atomic ?? "0"),
        amount_y_atomic: String(meta.amount_y_atomic ?? pp?.amount_y_atomic ?? "0"),
        strategy_key: String(meta.strategy_key ?? pp?.strategy_key ?? "BidAsk"),
        mix_done: mixDone,
        mix_total: mixTotal,
        mix_spot_x_atomic: String(meta.mix_spot_x_atomic ?? pp?.mix_spot_x_atomic ?? "0"),
        mix_spot_y_atomic: String(meta.mix_spot_y_atomic ?? pp?.mix_spot_y_atomic ?? "0"),
      };
      upsertTrackedPosition({ ...base, partial });
      const stage = isWide && addDone < addTotal ? `liquidity ${addDone}/${addTotal} chunk` : `Spot (Mix) ${mixDone}/${mixTotal}`;
      return {
        success: false,
        signatures: result.signatures,
        error: `Deploy sebagian (${stage}): ${result.error}`,
        keyboard: partialKb(posAddr),
      };
    }
    return { success: false, signatures: result.signatures, error: result.error };
  }

  if (purpose === "claim" || purpose === "remove") {
    const pool = String(payload.pool);
    const position = String(payload.position);
    // Built at EXECUTION time (never from preview); executor refreshes blockhash per attempt,
    // rebroadcasts, and auto-rebuilds up to 2x on expiry. Remove = claim+remove+close in one flow.
    const t0 = Date.now();
    const txs =
      purpose === "claim"
        ? await buildClaimFeeTxs({ poolAddress: pool, positionAddress: position })
        : await buildRemoveAndCloseTxs({ poolAddress: pool, positionAddress: position });
    const tBuild = Date.now() - t0;
    const result = await executePendingTxs(txs, [], { onProgress: hooks.onProgress });
    if (purpose === "remove" && result.success) {
      removeTrackedPosition(position);
    }
    const timing = `⏱ build ${(tBuild / 1000).toFixed(1)}s · send ${((result.timings || []).reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s (${txs.length} tx) · total ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    return {
      success: result.success,
      signatures: result.signatures,
      message: [result.message || result.error || (purpose === "remove" ? "Claim+remove+close OK" : "Claim OK"), timing].join("\n"),
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

  if (purpose === "flip") {
    const r = await executeFlip(payload.analysis as never);
    return { success: r.success, signatures: r.signatures, message: r.message, error: r.error };
  }

  if (purpose === "reshape") {
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
      onStage: hooks.onStage,
      onProgress: hooks.onProgress,
    });
    return {
      success: result.success,
      signatures: result.signatures,
      message: result.message,
      error: result.error,
    };
  }

  if (purpose === "withdraw") {
    const cfg = loadConfig({ requireTelegram: false });
    assertUsdCap("swap", Number(payload.usd));
    const item = await buildWithdrawTx(cfg.walletPublicKey, new PublicKey(String(payload.to)), Number(payload.lamports));
    const r = await executePendingTxs([item]);
    return { success: r.success, signatures: r.signatures, message: r.success ? "SOL terkirim." : r.message, error: r.error };
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
        poolBlock(p, i, p.pool),
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
      return `${i + 1}. ${p.pool_name || shortAddr(String(p.pool))}\n   Nilai ${p.total_value_usd == null ? "n/a" : fmtUsd(Number(p.total_value_usd))} | PnL ${p.pnl_usd == null ? "n/a" : `${fmtUsd(Number(p.pnl_usd))} (${fmtNum(Number(p.pnl_pct), 2)}%) estimasi`}\n   Fees ${p.unclaimed_fees_usd == null ? "n/a" : fmtUsd(Number(p.unclaimed_fees_usd))} | ${ir}`;
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
      `In   \`${quote.inputMint}\``,
      `Out  \`${quote.outputMint}\``,
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
    await presentConfirm(ctx, summary, req.id);
  } catch (e) {
    await ctx.reply(`❌ Swap gagal: ${(e as Error).message}`, { reply_markup: mainMenuKeyboard() });
  }
}

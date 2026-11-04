import { InlineKeyboard, type Bot, type Context } from "grammy";
import { loadConfig, CONFIRM_TTL_MS } from "../config.js";
import { fmtNum, fmtUsd, shortAddr } from "../format.js";
import { redactSecrets } from "../logger.js";
import { getSession, resetSession } from "./session.js";
import { confirmKeyboard, mainMenuKeyboard } from "./menus.js";
import { loadSettings, saveSettings } from "../store/settings.js";
import { searchPools, getActiveBin } from "../engine/dlmm-read.js";
import { buildAddLiquidityTxs, binsFromPct } from "../engine/dlmm-build.js";
import { getSolUsd } from "../engine/prices.js";
import { createConfirm } from "../engine/confirm.js";
import { assertUsdCap } from "../engine/executor.js";
import { requireStrategy, listStrategies } from "../strategies/index.js";
import {
  getSwapSlippagePct,
  getLiqSlippagePct,
  setSwapSlippagePct,
  setLiqSlippagePct,
} from "../engine/slippage.js";
import {
  type AddPanelState,
  defaultPanel,
  setStrategy,
  setRangePreset,
  parsePositiveNumber,
  parseBins,
  parsePriceRange,
  renderPanelText,
  panelKeyboard,
  panelMissing,
  strategyPickerKeyboard,
  modePickerKeyboard,
  rangePickerKeyboard,
  amountPickerKeyboard,
  rangeLabel,
  modeLabel,
} from "./add-panel.js";

const key = (ctx: Context) => String(ctx.chat?.id ?? "");

/** Edit a tracked message in place; fall back to a new message if it can't be edited. */
async function upsert(
  ctx: Context,
  msgId: number | undefined,
  text: string,
  kb: InlineKeyboard,
): Promise<number> {
  const chatId = ctx.chat!.id;
  if (msgId) {
    try {
      await ctx.api.editMessageText(chatId, msgId, text, { reply_markup: kb });
      return msgId;
    } catch (e) {
      if (/not modified/i.test(String((e as Error).message))) return msgId;
    }
  }
  const m = await ctx.reply(text, { reply_markup: kb });
  return m.message_id;
}

async function deleteUserMsg(ctx: Context): Promise<void> {
  try {
    if (ctx.message) await ctx.deleteMessage();
  } catch {
    /* ignore */
  }
}

function panelOf(ctx: Context): AddPanelState {
  const s = getSession(key(ctx));
  if (!s.data.panel) s.data.panel = defaultPanel();
  return s.data.panel;
}

export async function renderAddPanel(ctx: Context, note?: string): Promise<void> {
  const s = getSession(key(ctx));
  const p = panelOf(ctx);
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const text = renderPanelText(p, {
    liqSlippagePct: getLiqSlippagePct(),
    maxPositionUsd: cfg.maxPositionUsd,
    dryRun: cfg.dryRun,
    note,
  });
  s.data.panelMsgId = await upsert(ctx, s.data.panelMsgId, text, panelKeyboard(p));
}

async function showSub(ctx: Context, text: string, kb: InlineKeyboard): Promise<void> {
  const s = getSession(key(ctx));
  s.data.panelMsgId = await upsert(ctx, s.data.panelMsgId, text, kb);
}

const BACK_KB = () => new InlineKeyboard().text("⬅️ Kembali ke panel", "ap:back");

/** /add — open a fresh panel. */
export async function startAdd(ctx: Context): Promise<void> {
  resetSession(key(ctx));
  const s = getSession(key(ctx));
  s.data.panel = defaultPanel();
  await renderAddPanel(ctx, "Mulai dari ✏️ Pool (atau paste CA token di chat).");
}

/** Pool list rendered into the panel message (used by CA paste and ✏️ Pool). */
export async function showPoolPickerForPanel(ctx: Context, pools: Array<Record<string, unknown>>): Promise<void> {
  const s = getSession(key(ctx));
  s.data.pools = pools;
  if (!s.data.panel) s.data.panel = defaultPanel();
  const kb = new InlineKeyboard();
  pools.forEach((p, i) => {
    const label = `${p.name} | step ${p.bin_step} | fee ${fmtNum(Number(p.fee_pct), 2)}% | TVL ${fmtUsd(Number(p.tvl))}`;
    kb.text(label.slice(0, 64), `ap:pool:${i}`).row();
  });
  kb.text("⬅️ Kembali ke panel", "ap:back");
  await showSub(ctx, `🏊 Pilih pool DLMM (urut TVL, ${pools.length} hasil):`, kb);
}

async function resolveBins(p: AddPanelState): Promise<{ below: number; above: number; downPct: number | null; upPct: number | null }> {
  const r = p.range;
  if (r.kind === "bins") return { below: r.below, above: r.above, downPct: null, upPct: null };
  const poolAddr = String(p.pool?.pool || "");
  const ab = await getActiveBin(poolAddr);
  const binStep = Number(p.pool?.bin_step || 100);
  let down: number;
  let up: number;
  if (r.kind === "preset") {
    down = r.downPct;
    up = r.upPct;
  } else {
    down = ab.price > 0 ? Math.max(0, ((ab.price - r.min) / ab.price) * 100) : 0;
    up = ab.price > 0 ? Math.max(0, ((r.max - ab.price) / ab.price) * 100) : 0;
  }
  return {
    below: binsFromPct(ab.price, down, binStep, "down"),
    above: binsFromPct(ab.price, up, binStep, "up"),
    downPct: down,
    upPct: up,
  };
}

async function deployPanel(ctx: Context): Promise<void> {
  const p = panelOf(ctx);
  const missing = panelMissing(p);
  if (missing.length) return renderAddPanel(ctx, `Belum lengkap: ${missing.join(", ")}`);
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  try {
    const solUsd = await getSolUsd();
    const costUsd = (p.amountSol || 0) * solUsd;
    assertUsdCap("position", costUsd); // MAX_POSITION_USD safeguard (checked again on execute)
    await renderAddPanel(ctx, "⏳ Membangun transaksi…");
    const bins = await resolveBins(p);
    const strat = requireStrategy(p.strategyId);
    const built = await buildAddLiquidityTxs({
      poolAddress: String(p.pool?.pool),
      strategy: strat,
      side: p.side,
      amountSol: Number(p.amountSol || 0),
      amountTokenUi: p.amountToken,
      range: {
        binsBelow: bins.below,
        binsAbove: bins.above,
        downPct: bins.downPct,
        upPct: bins.upPct,
        mode: p.range.kind === "preset" ? "preset_pct" : p.range.kind === "bins" ? "custom_bins" : "custom_price",
      },
      poolName: String(p.pool?.name || ""),
    });
    const summary = [
      "Konfirmasi Add LP:",
      `Pool: ${p.pool?.name}`,
      `Strategi: ${strat.label} | mode: ${modeLabel(p.side)}`,
      `Amount: ${fmtNum(p.amountSol)} SOL` + (p.side === "two_sided" ? ` + token ${fmtNum(p.amountToken ?? 0)}` : ""),
      `Range: ${rangeLabel(p.range)}`,
      `Bins bawah/atas: ${bins.below} / ${bins.above}`,
      `Slippage LIQ: ${getLiqSlippagePct()}%`,
      `Perkiraan cost: ${fmtUsd(costUsd)} (cap ${fmtUsd(cfg.maxPositionUsd)})`,
      `Position baru: ${shortAddr(built.position)}`,
      cfg.dryRun ? "Mode: DRY_RUN (simulasi)" : "Mode: LIVE — akan ditandatangani & dikirim",
      `Konfirmasi dalam ${CONFIRM_TTL_MS / 1000}s.`,
    ].join("\n");
    const req = createConfirm({
      purpose: "add",
      summary,
      payload: { txs: built.txs, meta: built.meta, cost_usd: costUsd },
    });
    await renderAddPanel(ctx, "Menunggu Confirm di pesan bawah ⬇️ (Cancel = panel tetap bisa diedit).");
    await ctx.reply(summary, { reply_markup: confirmKeyboard(req.id) });
  } catch (e) {
    await renderAddPanel(ctx, `❌ ${redactSecrets((e as Error).message)}`);
  }
}

export function registerAddPanel(bot: Bot): void {
  bot.callbackQuery("ap:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    getSession(key(ctx)).awaitingText = null;
    await renderAddPanel(ctx);
  });
  bot.callbackQuery("ap:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    resetSession(key(ctx));
    await ctx.editMessageText("❌ Add LP dibatalkan.", { reply_markup: mainMenuKeyboard() });
  });
  bot.callbackQuery("ap:deploy", async (ctx) => {
    await ctx.answerCallbackQuery();
    getSession(key(ctx)).awaitingText = null;
    await deployPanel(ctx);
  });

  bot.callbackQuery(/^ap:edit:(pool|amount|token|mode|strat|range|slip)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = getSession(key(ctx));
    const p = panelOf(ctx);
    s.data.panelMsgId = ctx.callbackQuery.message?.message_id ?? s.data.panelMsgId;
    s.awaitingText = null;
    const field = ctx.match![1];
    if (field === "pool") {
      s.awaitingText = async (text) => {
        await deleteUserMsg(ctx);
        try {
          const pools = await searchPools(text.trim(), 8);
          if (!pools.length) {
            s.awaitingText = s.awaitingText;
            return renderAddPanel(ctx, `Tidak ada pool DLMM untuk “${text.trim()}”.`);
          }
          await showPoolPickerForPanel(ctx, pools as unknown as Array<Record<string, unknown>>);
        } catch (e) {
          await renderAddPanel(ctx, `❌ ${redactSecrets((e as Error).message)}`);
        }
      };
      return showSub(ctx, "🏊 Kirim token mint (CA) / alamat pool / query di chat:", BACK_KB());
    }
    if (field === "amount") return showSub(ctx, "💵 Pilih amount SOL:", amountPickerKeyboard(loadSettings().amountPresets));
    if (field === "token") {
      s.awaitingText = async (text) => {
        await deleteUserMsg(ctx);
        const n = Number(String(text).trim().replace(",", "."));
        if (!Number.isFinite(n) || n < 0) return renderAddPanel(ctx, "Amount token tidak valid.");
        p.amountToken = n;
        await renderAddPanel(ctx, "Amount token diperbarui.");
      };
      return showSub(ctx, "🪙 Ketik amount token (UI amount, 0 = hanya SOL):", BACK_KB());
    }
    if (field === "mode") return showSub(ctx, "🧭 Pilih mode deposit:", modePickerKeyboard(p.side));
    if (field === "strat") return showSub(ctx, "📐 Pilih strategi:", strategyPickerKeyboard(p.strategyId));
    if (field === "range") return showSub(ctx, `📏 Pilih range (${requireStrategy(p.strategyId).label}):`, rangePickerKeyboard(p));
    if (field === "slip") {
      s.awaitingText = async (text) => {
        await deleteUserMsg(ctx);
        try {
          setLiqSlippagePct(Number(String(text).replace(",", ".")));
          await renderAddPanel(ctx, `Slippage LIQ = ${getLiqSlippagePct()}% (tersimpan global).`);
        } catch (e) {
          await renderAddPanel(ctx, `❌ ${(e as Error).message}`);
        }
      };
      return showSub(ctx, `🎚 Ketik slippage liquidity % (0.1–50). Sekarang ${getLiqSlippagePct()}%:`, BACK_KB());
    }
  });

  bot.callbackQuery(/^ap:pool:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = getSession(key(ctx));
    const pool = s.data.pools?.[Number(ctx.match![1])];
    s.data.panelMsgId = ctx.callbackQuery.message?.message_id ?? s.data.panelMsgId;
    if (!pool) return renderAddPanel(ctx, "Daftar pool kadaluarsa — ✏️ Pool lagi.");
    panelOf(ctx).pool = pool;
    await renderAddPanel(ctx, panelOf(ctx).amountSol ? undefined : "Pool dipilih. Isi ✏️ Amount lalu 🚀 Deploy.");
  });

  bot.callbackQuery(/^ap:set:(amt|mode|strat|rng):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = getSession(key(ctx));
    s.data.panelMsgId = ctx.callbackQuery.message?.message_id ?? s.data.panelMsgId;
    const p = panelOf(ctx);
    const kind = ctx.match![1];
    const v = ctx.match![2];
    try {
      if (kind === "amt") {
        if (v === "manual") {
          s.awaitingText = async (text) => {
            await deleteUserMsg(ctx);
            const n = parsePositiveNumber(text);
            if (n == null) return renderAddPanel(ctx, "Amount tidak valid.");
            p.amountSol = n;
            await renderAddPanel(ctx);
          };
          return showSub(ctx, "💵 Ketik amount SOL:", BACK_KB());
        }
        const a = loadSettings().amountPresets[Number(v)];
        if (a) p.amountSol = a;
      } else if (kind === "mode") {
        p.side = v === "two_sided" ? "two_sided" : "one_sided_sol";
        if (p.side === "two_sided" && p.amountToken == null) p.amountToken = 0;
      } else if (kind === "strat") {
        s.data.panel = setStrategy(p, v);
      } else if (kind === "rng") {
        if (v === "_bins") {
          s.awaitingText = async (text) => {
            await deleteUserMsg(ctx);
            const b = parseBins(text);
            if (!b) return renderAddPanel(ctx, "Format bins: <bawah> <atas>, contoh 40 2");
            panelOf(ctx).range = { kind: "bins", below: b.below, above: b.above };
            await renderAddPanel(ctx);
          };
          return showSub(ctx, "📏 Ketik: <bins_bawah> <bins_atas>  (contoh: 40 2)", BACK_KB());
        }
        if (v === "_price") {
          s.awaitingText = async (text) => {
            await deleteUserMsg(ctx);
            const r = parsePriceRange(text);
            if (!r) return renderAddPanel(ctx, "Format harga: <min> <max> (min < max)");
            panelOf(ctx).range = { kind: "price", min: r.min, max: r.max };
            await renderAddPanel(ctx);
          };
          return showSub(ctx, "📏 Ketik: <harga_min> <harga_max> (harga pool)", BACK_KB());
        }
        s.data.panel = setRangePreset(p, v);
      }
      await renderAddPanel(ctx);
    } catch (e) {
      await renderAddPanel(ctx, `❌ ${(e as Error).message}`);
    }
  });
}

// ── Settings panel ──────────────────────────────────────────────

function settingsText(note?: string): string {
  const st = loadSettings();
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  return [
    "⚙️ Settings",
    "",
    `🎚 SWAP slippage: ${getSwapSlippagePct()}% (Jupiter bps = ×100)`,
    `🎚 LIQ slippage: ${getLiqSlippagePct()}% (Meteora %)`,
    `💵 Amount presets: ${st.amountPresets.join(", ")} SOL`,
    "",
    "🔒 Dari .env (ubah manual di server):",
    `DRY_RUN: ${cfg.dryRun} | MAX_POSITION_USD: ${cfg.maxPositionUsd} | MAX_SWAP_USD: ${cfg.maxSwapUsd}`,
    `Strategi: ${listStrategies().map((x) => x.label).join(", ")}`,
    "Zapout dikecualikan dari penolakan MAX_SWAP_USD (hanya peringatan).",
    note ? `\nℹ️ ${note}` : null,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

function settingsKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✏️ SWAP slippage", "st:edit:swap")
    .row()
    .text("✏️ LIQ slippage", "st:edit:liq")
    .row()
    .text("✏️ Amount presets", "st:edit:presets")
    .row()
    .text("⬅️ Menu", "menu:cancel");
}

async function renderSettings(ctx: Context, note?: string): Promise<void> {
  const s = getSession(key(ctx));
  s.data.settingsMsgId = await upsert(ctx, s.data.settingsMsgId, settingsText(note), settingsKb());
}

export async function showSettings(ctx: Context): Promise<void> {
  const s = getSession(key(ctx));
  s.data.settingsMsgId = undefined;
  await renderSettings(ctx);
}

export function parsePresets(text: string): number[] | null {
  const arr = text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((x) => Number(x));
  if (!arr.length || arr.length > 6 || !arr.every((n) => Number.isFinite(n) && n > 0)) return null;
  return arr;
}

export function registerSettingsPanel(bot: Bot): void {
  bot.callbackQuery("st:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    getSession(key(ctx)).awaitingText = null;
    await renderSettings(ctx);
  });
  bot.callbackQuery(/^st:edit:(swap|liq|presets)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = getSession(key(ctx));
    s.data.settingsMsgId = ctx.callbackQuery.message?.message_id ?? s.data.settingsMsgId;
    const f = ctx.match![1];
    const back = new InlineKeyboard().text("⬅️ Kembali", "st:back");
    s.awaitingText = async (text) => {
      await deleteUserMsg(ctx);
      try {
        if (f === "presets") {
          const arr = parsePresets(text);
          if (!arr) return renderSettings(ctx, "Format presets: angka SOL dipisah spasi/koma, max 6. contoh: 0.5 1 2");
          const st = loadSettings();
          st.amountPresets = arr;
          saveSettings(st);
          return renderSettings(ctx, "Amount presets tersimpan.");
        }
        const n = Number(String(text).replace(",", "."));
        if (f === "swap") setSwapSlippagePct(n);
        else setLiqSlippagePct(n);
        await renderSettings(ctx, "Tersimpan.");
      } catch (e) {
        await renderSettings(ctx, `❌ ${(e as Error).message}`);
      }
    };
    const prompt =
      f === "presets"
        ? `Ketik amount presets SOL (contoh: 0.5 1 2). Sekarang: ${loadSettings().amountPresets.join(", ")}`
        : `Ketik ${f === "swap" ? "SWAP" : "LIQ"} slippage % (0.1–50). Sekarang: ${f === "swap" ? getSwapSlippagePct() : getLiqSlippagePct()}%`;
    s.data.settingsMsgId = await upsert(ctx, s.data.settingsMsgId, `⚙️ ${prompt}`, back);
  });
}

// ── Telegram command menu (☰) ──────────────────────────────────

export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "menu", description: "Menu utama (tombol)" },
  { command: "add", description: "Buka posisi DLMM (panel edit)" },
  { command: "positions", description: "Lihat posisi terbuka" },
  { command: "claim", description: "Claim fee posisi" },
  { command: "remove", description: "Tarik 100% & tutup posisi" },
  { command: "reshape", description: "Claim + flip token ke BidAsk" },
  { command: "zapout", description: "Tutup posisi & swap semua ke SOL" },
  { command: "swap", description: "Swap via Jupiter" },
  { command: "pools", description: "Cari pool DLMM dari mint" },
  { command: "balance", description: "Saldo wallet" },
  { command: "settings", description: "Pengaturan (slippage, presets)" },
  { command: "cancel", description: "Batalkan alur yang berjalan" },
  { command: "start", description: "Mulai / menu utama" },
];

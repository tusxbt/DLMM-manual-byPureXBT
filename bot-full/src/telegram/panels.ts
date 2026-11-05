import { DEFAULT_RANGE_PCT } from "../store/settings.js";
import { poolBlock, poolButtonLabel } from "./pool-format.js";
import { screen, section, kv } from "./layout.js";
import { getSupplyUi, marketCap } from "../engine/supply.js";
import { renderAddPreview, binArrayWarning, fundsLines } from "./preview.js";
import { checkFunds } from "../engine/funds-check.js";
import { presentConfirm } from "./confirm-ui.js";
import { addBackKeyboard } from "./menus.js";
import { cancelConfirm } from "../engine/confirm.js";
import { InlineKeyboard, Keyboard, type Bot, type Context } from "grammy";
import { loadConfig, CONFIRM_TTL_MS, SOL_MINT } from "../config.js";
import { fmtNum, fmtUsd, shortAddr } from "../format.js";
import { redactSecrets } from "../logger.js";
import { getSession, resetSession, RETRY } from "./session.js";

/** Show the error in place and keep waiting for another typed value. */
const retry = async (p: Promise<unknown>): Promise<typeof RETRY> => {
  await p;
  return RETRY;
};
import { confirmKeyboard, mainMenuKeyboard } from "./menus.js";
import { loadSettings, saveSettings, type Settings } from "../store/settings.js";
import { searchPools, getActiveBin } from "../engine/dlmm-read.js";
import { buildAddLiquidityTxs } from "../engine/dlmm-build.js";
import { getSolUsd } from "../engine/prices.js";
import { createConfirm } from "../engine/confirm.js";
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
  setRangeChoice,
  parsePositiveNumber,
  parseBins,
  parsePriceRange,
  sidePct,
  parsePctRange,
  renderPanelText,
  panelKeyboard,
  panelMissing,
  rangePickerKeyboard,
  rangeLabel,
  modeLabel,
  computeRange,
  amountFromPct,
  depositUsd,
  amountText,
  hasToken,
  tokenSymbol,
  tokenMint,
  MAX_BINS_PER_POSITION,
  DEFAULT_BIN_PRESETS,
  pctLabel,
} from "./add-panel.js";
import { PublicKey } from "@solana/web3.js";
import { isAutoConfirm, setAutoConfirm, AUTO_BADGE } from "./confirm-ui.js";
import { getConnection } from "../engine/connection.js";
import { getWalletPublicKey } from "../engine/wallet.js";
import { getUsdPrices } from "../engine/prices.js";

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
  if (!s.data.panel) s.data.panel = defaultPanel(undefined, loadSettings().binPresets);
  return s.data.panel;
}

export async function renderAddPanel(ctx: Context, note?: string): Promise<void> {
  const s = getSession(key(ctx));
  const p = panelOf(ctx);
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const st = loadSettings();
  const text = renderPanelText(p, {
    liqSlippagePct: getLiqSlippagePct(),
    dryRun: cfg.dryRun,
    note,
  });
  s.data.panelMsgId = await upsert(
    ctx,
    s.data.panelMsgId,
    text,
    panelKeyboard(p, { binPresets: st.binPresets, amountPresets: st.amountPresets, rangePct: st.rangePct }),
  );
}

async function showSub(ctx: Context, text: string, kb: InlineKeyboard): Promise<void> {
  const s = getSession(key(ctx));
  s.data.panelMsgId = await upsert(ctx, s.data.panelMsgId, text, kb);
}

const BACK_KB = () => new InlineKeyboard().text("⬅️ Panel", "ap:back");

function askPool(ctx: Context): Promise<void> {
  const s = getSession(key(ctx));
  s.awaitingText = async (text) => {
    await deleteUserMsg(ctx);
    try {
      const pools = await searchPools(text.trim(), 8);
      if (!pools.length) return renderAddPanel(ctx, `Tidak ada pool DLMM untuk “${text.trim()}”.`);
      await showPoolPickerForPanel(ctx, pools as unknown as Array<Record<string, unknown>>);
    } catch (e) {
      await renderAddPanel(ctx, `❌ ${redactSecrets((e as Error).message)}`);
    }
  };
  return showSub(ctx, "🏊 Paste token mint (CA) / alamat pool / query di chat:", new InlineKeyboard().text("🏠 Home", "ap:home"));
}

/** /add — ask for a pool (CA paste also works anytime). */
export async function startAdd(ctx: Context): Promise<void> {
  resetSession(key(ctx));
  const s = getSession(key(ctx));
  s.data.panel = defaultPanel(undefined, loadSettings().binPresets);
  await askPool(ctx);
}

/** Pool list rendered into the panel message (used by CA paste and ← Pools). */
export async function showPoolPickerForPanel(ctx: Context, pools: Array<Record<string, unknown>>): Promise<void> {
  const s = getSession(key(ctx));
  s.data.pools = pools;
  if (!s.data.panel) s.data.panel = defaultPanel(undefined, loadSettings().binPresets);
  const kb = new InlineKeyboard();
  pools.forEach((p, i) => {
    kb.text(poolButtonLabel(p), `ap:pool:${i}`).row();
  });
  kb.text("🔍 Cari lagi", "ap:search").text("🏠 Home", "ap:home");
  const lines = pools.map((p, i) => poolBlock(p, i));
  await showSub(ctx, [`**🏊 Pilih pool DLMM**`, lines.join("\n")].join("\n\n"), kb);
}

/** Fetch active price, SOL/USD, token price and wallet balances; failures are non-fatal. */
async function refreshPoolInfo(p: AddPanelState): Promise<void> {
  if (!p.pool?.pool) return;
  try {
    p.activePrice = (await getActiveBin(String(p.pool.pool))).price;
    try {
      const m = tokenMint(p);
      p.supply = m ? await getSupplyUi(m) : null;
    } catch {
      p.supply = null;
    }
  } catch {
    p.activePrice = undefined;
  }
  const mint = tokenMint(p);
  try {
    const prices = await getUsdPrices([SOL_MINT, mint]);
    p.solUsd = prices[SOL_MINT] ?? p.solUsd;
    p.tokenUsd = mint ? prices[mint] : undefined;
  } catch {
    /* ignore */
  }
  try {
    const conn = getConnection();
    const owner = getWalletPublicKey();
    p.solBalance = (await conn.getBalance(owner)) / 1e9;
    if (mint) {
      const acc = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
      p.tokenBalance = acc.value.reduce(
        (sum, a) => sum + Number(a.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0),
        0,
      );
    }
  } catch {
    /* keep previous */
  }
}

async function deployPanel(ctx: Context): Promise<void> {
  const p = panelOf(ctx);
  const missing = panelMissing(p);
  if (missing.length) return renderAddPanel(ctx, `Belum lengkap: ${missing.join(", ")}`);
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  try {
    await renderAddPanel(ctx, "⏳ Membangun preview…");
    await refreshPoolInfo(p); // fresh price + balances for exact bin math and cap
    const costUsd = depositUsd(p);
    if (p.side !== "one_sided_sol" && (p.amountToken ?? 0) > (p.tokenBalance ?? 0))
      return renderAddPanel(ctx, `⛔ Saldo ${tokenSymbol(p)} tidak cukup.`);
    const c = computeRange(p, Number(p.pool?.bin_step || 0), p.activePrice);
    if (c.error) return renderAddPanel(ctx, `⛔ ${c.error}`);
    if (c.total > MAX_BINS_PER_POSITION) return renderAddPanel(ctx, `⛔ Maks ${MAX_BINS_PER_POSITION} bins per posisi.`);
    const strat = requireStrategy(p.strategyId);
    const sol = p.side === "one_sided_token" ? 0 : Number(p.amountSol || 0);
    const tok = p.side === "one_sided_sol" ? 0 : Number(p.amountToken || 0);
    const built = await buildAddLiquidityTxs({
      poolAddress: String(p.pool?.pool),
      strategy: strat,
      // builder: one_sided_sol = SOL only; two_sided = X+Y (token side = token only, bins above)
      side: p.side === "one_sided_sol" ? "one_sided_sol" : "two_sided",
      amountSol: sol,
      amountTokenUi: tok,
      range: {
        binsBelow: c.below,
        binsAbove: c.above,
        downPct: c.downPct,
        upPct: c.upPct,
        mode: p.range.kind === "preset" ? "preset_pct" : p.range.kind === "bins" ? "custom_bins" : "custom_price",
      },
      poolName: String(p.pool?.name || ""),
      mixPct: loadSettings().mixBidAskPct,
    });
    const rent = built.rent ?? built.quote ?? null;
    const funds = checkFunds({
      haveSol: p.solBalance,
      amountSol: sol,
      positionRentSol: rent?.positionRentSol,
      binArrayRentSol: rent?.binArrayRentSol,
      txCount: built.txs.length,
    });
    if (!funds.ok && !cfg.dryRun) {
      const warn = binArrayWarning(rent);
      const s2 = getSession(key(ctx));
      s2.data.panelMsgId = await upsert(
        ctx,
        s2.data.panelMsgId,
        `${fundsLines(funds)}${warn ? `\n\n${warn}` : ""}\n\nKurangi nominal atau top-up SOL.`,
        addBackKeyboard(),
      );
      return;
    }
    const sup = tokenMint(p) ? await getSupplyUi(tokenMint(p)!) : null;
    const summary = renderAddPreview({
      pool: String(p.pool?.name || ""),
      side: modeLabel(p.side),
      strategy: built.mix ? `Mix ${built.mix.pct}/${100 - built.mix.pct}` : strat.label,
      amount: amountText(p),
      mix: built.mix ?? null,
      bins: c.total,
      below: c.below,
      above: c.above,
      downPct: c.downPct,
      upPct: c.upPct,
      minPrice: c.minPrice,
      maxPrice: c.maxPrice,
      solUsd: p.solUsd,
      mcMin: marketCap(c.minPrice, p.solUsd, sup),
      mcMax: marketCap(c.maxPrice, p.solUsd, sup),
      mcNow: marketCap(p.activePrice, p.solUsd, sup),
      clamped: c.clamped,
      costUsd: costUsd ?? NaN,
      slippagePct: getLiqSlippagePct(),
      wide: built.quote ?? null,
      rent,
      funds,
      position: built.position,
      dryRun: cfg.dryRun,
      ttlSec: CONFIRM_TTL_MS / 1000,
    });
    const req = createConfirm({
      purpose: "add",
      summary,
      payload: { txs: built.txs, meta: { ...built.meta, entry_price: p.activePrice ?? null }, cost_usd: costUsd },
    });
    // same message: panel → Preview (Confirm / Cancel / ⬅️ Kembali)
    const sess = getSession(key(ctx));
    const prompted = await presentConfirm(ctx, summary, req.id, { msgId: sess.data.panelMsgId ?? ctx.callbackQuery?.message?.message_id, back: true });
    void prompted;
  } catch (e) {
    await renderAddPanel(ctx, `❌ ${redactSecrets((e as Error).message)}`);
  }
}

export function registerAddPanel(bot: Bot): void {
  const track = (ctx: Context) => {
    const s = getSession(key(ctx));
    s.data.panelMsgId = ctx.callbackQuery?.message?.message_id ?? s.data.panelMsgId;
    return s;
  };
  // Preview → back to setup panel (same message); the pending confirm is cancelled
  bot.callbackQuery(/^ap:pvback:([a-f0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    cancelConfirm(ctx.match![1]);
    const s = track(ctx);
    s.awaitingText = null;
    await renderAddPanel(ctx);
  });
  bot.callbackQuery("ap:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    track(ctx).awaitingText = null;
    await renderAddPanel(ctx);
  });
  bot.callbackQuery(/^ap:(cancel|home)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    resetSession(key(ctx));
    const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
    await ctx.editMessageText(`🏠 Tusvicious — ${cfg.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"}\nPilih aksi:`, {
      reply_markup: mainMenuKeyboard(),
    });
  });
  bot.callbackQuery("ap:search", async (ctx) => {
    await ctx.answerCallbackQuery();
    track(ctx);
    await askPool(ctx);
  });
  bot.callbackQuery("ap:pools", async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = track(ctx);
    s.awaitingText = null;
    if (s.data.pools?.length) return showPoolPickerForPanel(ctx, s.data.pools);
    await askPool(ctx);
  });
  bot.callbackQuery("ap:deploy", async (ctx) => {
    await ctx.answerCallbackQuery();
    track(ctx).awaitingText = null;
    await deployPanel(ctx);
  });

  bot.callbackQuery(/^ap:edit:(amount|range|slip)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = track(ctx);
    const p = panelOf(ctx);
    s.awaitingText = null;
    const field = ctx.match![1];
    if (field === "amount") {
      const sym = tokenSymbol(p);
      s.awaitingText = async (text) => {
        await deleteUserMsg(ctx);
        if (p.side === "two_sided") {
          const [a, b] = text.trim().replace(/,/g, ".").split(/\s+/).map(Number);
          if (!Number.isFinite(a) || a < 0 || !Number.isFinite(b ?? 0) || (b ?? 0) < 0)
            return retry(renderAddPanel(ctx, "Format Double: <sol> <token>, contoh 0.5 1000"));
          p.amountSol = a;
          p.amountToken = b ?? 0;
        } else {
          const n = parsePositiveNumber(text);
          if (n == null) return retry(renderAddPanel(ctx, "Nominal tidak valid."));
          if (p.side === "one_sided_sol") p.amountSol = n;
          else p.amountToken = n;
        }
        p.amountPct = null;
        await renderAddPanel(ctx);
      };
      const prompt =
        p.side === "one_sided_sol"
          ? "💵 Ketik nominal SOL:"
          : p.side === "one_sided_token"
            ? `💵 Ketik nominal ${sym}:`
            : `💵 Ketik: <sol> <${sym}> (contoh 0.5 1000)`;
      return showSub(ctx, prompt, BACK_KB());
    }
    if (field === "range") return showSub(ctx, "📏 Range — default 69 bin (≈% tergantung bin step), 4 preset %, atau custom (% / bins / harga). Maks 1400 bins (dipotong otomatis); >69 bins = posisi lebar multi-tx.", rangePickerKeyboard(p, loadSettings().rangePct));
    if (field === "slip") {
      s.awaitingText = async (text) => {
        await deleteUserMsg(ctx);
        try {
          setLiqSlippagePct(Number(String(text).replace(",", ".")));
          await renderAddPanel(ctx, `Slippage = ${getLiqSlippagePct()}% (tersimpan global).`);
        } catch (e) {
          await renderAddPanel(ctx, `❌ ${(e as Error).message}`);
        }
      };
      return showSub(ctx, `🎚 Ketik slippage liquidity % (0.1–50). Sekarang ${getLiqSlippagePct()}%:`, BACK_KB());
    }
  });

  bot.callbackQuery(/^ap:pool:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = track(ctx);
    const pool = s.data.pools?.[Number(ctx.match![1])];
    if (!pool) return renderAddPanel(ctx, "Daftar pool kadaluarsa — ← Pools lagi.");
    const pp = panelOf(ctx);
    pp.pool = pool;
    pp.amountToken = undefined;
    await refreshPoolInfo(pp);
    if (!hasToken(pp) && pp.side !== "one_sided_sol") pp.side = "one_sided_sol";
    await renderAddPanel(ctx);
  });

  bot.callbackQuery(/^ap:set:(amt|pct|mode|strat|rng):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = track(ctx);
    const p = panelOf(ctx);
    const kind = ctx.match![1];
    const v = ctx.match![2];
    try {
      if (kind === "amt") {
        const a = loadSettings().amountPresets[Number(v)];
        if (a) {
          p.amountSol = a;
          p.amountPct = null;
        }
      } else if (kind === "pct") {
        const pct = Number(v);
        const amt = amountFromPct(p, pct);
        if (p.side !== "one_sided_token" && amt.sol <= 0 && p.side === "one_sided_sol")
          return renderAddPanel(ctx, "Saldo SOL tidak cukup (sisakan 0.05 SOL untuk fee).");
        if (p.side !== "one_sided_sol") p.amountToken = amt.token;
        if (p.side !== "one_sided_token") p.amountSol = amt.sol;
        p.amountPct = pct;
      } else if (kind === "mode") {
        const side = v as AddPanelState["side"];
        if (side !== "one_sided_sol" && !hasToken(p))
          return renderAddPanel(ctx, `💡 Wallet belum memegang ${tokenSymbol(p)} — Token side / Double tidak tersedia.`);
        p.side = side;
        p.amountPct = null;
        if (side === "one_sided_token") p.amountSol = undefined;
        if (side === "one_sided_sol") p.amountToken = undefined;
      } else if (kind === "strat") {
        s.data.panel = setStrategy(p, v);
      } else if (kind === "rng") {
        if (v === "_bins") {
          s.awaitingText = async (text) => {
            await deleteUserMsg(ctx);
            const b = parseBins(text);
            if (!b) return retry(renderAddPanel(ctx, "Format bins: <bawah> <atas>, contoh 40 2"));
            if (b.below + b.above > MAX_BINS_PER_POSITION)
              return retry(renderAddPanel(ctx, `⛔ Total ${b.below + b.above} bins > ${MAX_BINS_PER_POSITION}. Kecilkan.`));
            panelOf(ctx).range = { kind: "bins", below: b.below, above: b.above };
            await renderAddPanel(ctx);
          };
          return showSub(ctx, `📏 Ketik: <bins_bawah> <bins_atas>  (contoh: 40 2, total maks ${MAX_BINS_PER_POSITION})`, BACK_KB());
        }
        if (v.startsWith("_pp")) {
          const pp = loadSettings().rangePresets[Number(v.slice(3))];
          if (!pp) return renderAddPanel(ctx, "Preset % tidak ada.");
          p.range = { kind: "pct", ...sidePct(p.side, pp) };
          return renderAddPanel(ctx);
        }
        if (v === "_pct") {
          s.awaitingText = async (text) => {
            await deleteUserMsg(ctx);
            const cur = panelOf(ctx);
            const r = parsePctRange(text, cur.side);
            if ("error" in r) return retry(renderAddPanel(ctx, `⛔ ${r.error}`));
            cur.range = { kind: "pct", ...r };
            await renderAddPanel(ctx);
          };
          const hint =
            p.side === "one_sided_sol"
              ? "SOL side: atas tetap 0%. Ketik % turun, mis. `50` atau `0-50` (= −50%..0%), `70`."
              : p.side === "one_sided_token"
              ? "Token side: bawah tetap 0%. Ketik % naik, mis. `50` atau `0-50` (= 0%..+50%)."
              : "Double side: ketik `-50 +20` (= −50%..+20%), `50 20`, atau `30` (= ±30%).";
          return showSub(ctx, `📏 Range % · ${hint}\nBins dihitung dari bin step (maks 1400).`, BACK_KB());
        }
        if (v === "_price") {
          s.awaitingText = async (text) => {
            await deleteUserMsg(ctx);
            const r = parsePriceRange(text);
            if (!r) return retry(renderAddPanel(ctx, "Format harga: <min> <max> (min < max)"));
            panelOf(ctx).range = { kind: "price", min: r.min, max: r.max };
            await renderAddPanel(ctx);
          };
          return showSub(ctx, `📏 Ketik: <harga_min> <harga_max> dalam SOL per token${p.activePrice ? ` (aktif ${fmtNum(p.activePrice, 10)})` : ""}. >${MAX_BINS_PER_POSITION} bins akan dipotong.`, BACK_KB());
        }
        s.data.panel = /^(def|p[0-3])$/.test(v) ? setRangeChoice(p, v, loadSettings().rangePct) : setRangePreset(p, v, loadSettings().binPresets);
      }
      await renderAddPanel(ctx);
    } catch (e) {
      await renderAddPanel(ctx, `❌ ${(e as Error).message}`);
    }
  });
}

/** Reposition step 2: fresh Add panel on the same pool, same width (bins) below current price. */
export async function openRepositionPanel(ctx: Context, poolAddress: string, bins: number): Promise<void> {
  const s = getSession(key(ctx));
  s.data.panel = defaultPanel(undefined, loadSettings().binPresets);
  s.data.panelMsgId = undefined;
  try {
    const hit = (await searchPools(poolAddress, 1)).find((x) => x.pool === poolAddress);
    if (!hit) return void (await ctx.reply("Pool tidak ditemukan untuk reposition — pakai /add."));
    const p = s.data.panel;
    p.pool = hit as unknown as Record<string, unknown>;
    p.range = { kind: "bins", below: Math.max(1, Math.min(MAX_BINS_PER_POSITION, bins)), above: 0 };
    await refreshPoolInfo(p);
    await renderAddPanel(ctx, "♻️ Reposition: lebar sama di bawah harga sekarang. Atur amount/sisi lalu 👀 Preview.");
  } catch (e) {
    await ctx.reply(`❌ ${redactSecrets((e as Error).message)}`);
  }
}

// ── Persistent reply keyboard (bottom bar) ──────────────────────

export const REPLY_KB_LABELS = {
  home: "🏠 Home",
  positions: "📊 Positions",
  trade: "💱 Trade",
  wallet: "👛 Wallet",
  settings: "⚙️ Settings",
} as const;

export function bottomKeyboard(): Keyboard {
  return new Keyboard()
    .text(REPLY_KB_LABELS.home)
    .text(REPLY_KB_LABELS.positions)
    .row()
    .text(REPLY_KB_LABELS.trade)
    .text(REPLY_KB_LABELS.wallet)
    .text(REPLY_KB_LABELS.settings)
    .resized()
    .persistent();
}

/** Map a bottom-bar label to an action id, or null. */
export function replyKbAction(text: string): keyof typeof REPLY_KB_LABELS | null {
  const t = text.trim();
  for (const [k, v] of Object.entries(REPLY_KB_LABELS)) if (t === v) return k as keyof typeof REPLY_KB_LABELS;
  return null;
}

// ── Settings panel ──────────────────────────────────────────────

export function settingsText(note?: string): string {
  const st = loadSettings();
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  return screen(
    "⚙️ Settings",
    note ? `ℹ️ ${note}` : null,
    section("🛡 Konfirmasi", [
      kv("Auto close", st.autoConfirm ? "⚡ ON" : "OFF"),
      st.autoConfirm ? "Exit & → SOL tanpa Confirm" : "Semua aksi pakai Confirm",
    ]),
    section("🎚 Slippage", [kv("Swap", `${getSwapSlippagePct()}%`), kv("Liquidity", `${getLiqSlippagePct()}%`)]),
    section("🚀 Priority fee", [
      kv("DLMM", st.priorityFeeMicroLamports > 0 ? `${st.priorityFeeMicroLamports} µL/CU` : "auto"),
      kv("Jup maks", `${st.jupPriorityMaxLamports} lamports`),
    ]),
    section("📏 Range & amount", [
      kv("Range", `Default 69 bin · ${st.rangePct.map((v) => v + "%").join(" / ")}`),
      kv("Range %", st.rangePresets.map((r) => pctLabel(r)).join(", ") || "-"),
      kv("Amount", `${st.amountPresets.join(" / ")} SOL`),
      kv("Mix", `BidAsk ${st.mixBidAskPct} / Spot ${100 - st.mixBidAskPct}`),
    ]),
    section("🔒 Dari .env", [
      kv("Mode", cfg.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"),
    ]),
  );
}

function settingsKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text(isAutoConfirm() ? "⚡ Auto close: ON" : "🛡 Auto close: OFF", "st:auto:toggle")
    .row()
    .text("✏️ Priority fee", "st:edit:prio")
    .text("✏️ Jup max fee", "st:edit:jupmax")
    .row()
    .text("✏️ SWAP slippage", "st:edit:swap")
    .row()
    .text("✏️ LIQ slippage", "st:edit:liq")
    .row()
    .text("✏️ Amount presets", "st:edit:presets")
    .row()
    .text("🎛 Tombol preset", "st:pre")
    .row()
    .text("✏️ Bin presets", "st:edit:bins")
    .text("✏️ Range % presets", "st:edit:pct")
    .row()
    .text("✏️ Mix ratio", "st:edit:mix")
    .text("🖼 Background PnL", "st:bg")
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

export function parsePctPresets(text: string): { down: number; up: number }[] | null {
  const parts = text.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  const out: { down: number; up: number }[] = [];
  for (const part of parts) {
    const r = parsePctRange(part, "two_sided");
    if ("error" in r) return null;
    // a bare "50" / "0-50" means −50% (mirrored to +50% on token side)
    const bare = /^\d+(\.\d+)?$/.test(part) || /^0\s*-\s*\d/.test(part);
    out.push(bare ? { down: Math.max(r.down, r.up), up: 0 } : r);
  }
  return out;
}

export function parseBinPresets(text: string): { narrow: number; medium: number; wide: number } | null {
  const a = text.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (a.length !== 3 || !a.every((n) => Number.isInteger(n) && n >= 1 && n <= 1399)) return null;
  return { narrow: a[0], medium: a[1], wide: a[2] };
}

export function registerSettingsPanel(bot: Bot): void {
  bot.callbackQuery(/^st:auto:(toggle|on|off)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = getSession(key(ctx));
    s.data.settingsMsgId = ctx.callbackQuery.message?.message_id ?? s.data.settingsMsgId;
    const a = ctx.match![1];
    if (a === "toggle") {
      if (isAutoConfirm()) {
        setAutoConfirm(false);
        return renderSettings(ctx, "Auto confirm close OFF — semua aksi butuh Confirm.");
      }
      const kb = new InlineKeyboard().text("⚡ Ya, aktifkan", "st:auto:on").text("❌ Batal", "st:back");
      s.data.settingsMsgId = await upsert(
        ctx,
        s.data.settingsMsgId,
        [
          "⚠️ Aktifkan Auto confirm close?",
          "",
          "Hanya aksi CLOSE yang langsung dikirim on-chain tanpa Confirm: 🚪 Exit (remove+close) dan ⚡ → SOL (zapout), termasuk langkah Exit di ♻️ Reposition.",
          "Deploy/Preview, swap, claim, flip/reshape, dan re-add Reposition TETAP butuh Confirm.",
          "Tetap berlaku: whitelist, DRY_RUN, cek signer.",
          "Salah tekan Exit/⚡ = posisi langsung ditutup. Pakai hanya dengan wallet terpisah dana kecil.",
        ].join("\n"),
        kb,
      );
      return;
    }
    setAutoConfirm(a === "on");
    await renderSettings(ctx, a === "on" ? `${AUTO_BADGE} (hanya Exit & ⚡ → SOL).` : "Auto confirm close OFF.");
  });

  // Per-slot editing of /add quick-pick buttons (bins + amount), per user
  bot.callbackQuery("st:pre", async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = getSession(key(ctx));
    s.awaitingText = null;
    s.data.settingsMsgId = ctx.callbackQuery.message?.message_id ?? s.data.settingsMsgId;
    s.data.settingsMsgId = await upsert(ctx, s.data.settingsMsgId, presetSlotsText(loadSettings()), presetSlotsKb(loadSettings()));
  });
  bot.callbackQuery("st:pre:reset", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Preset direset" });
    const st = resetPresetSlots(loadSettings());
    saveSettings(st);
    const s = getSession(key(ctx));
    s.data.settingsMsgId = await upsert(ctx, s.data.settingsMsgId, presetSlotsText(st, "Direset ke default."), presetSlotsKb(st));
  });
  bot.callbackQuery(/^st:slot:(rp|amt):([0-3])$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = getSession(key(ctx));
    s.data.settingsMsgId = ctx.callbackQuery.message?.message_id ?? s.data.settingsMsgId;
    const kind = ctx.match![1] as "rp" | "amt";
    const slot = ctx.match![2];
    const st0 = loadSettings();
    const cur = kind === "rp" ? st0.rangePct[Number(slot)] : st0.amountPresets[Number(slot)];
    s.awaitingText = async (text) => {
      await deleteUserMsg(ctx);
      const st = loadSettings();
      const r = applyPresetSlot(st, kind, slot, text);
      if (r.error) {
        s.data.settingsMsgId = await upsert(ctx, s.data.settingsMsgId, presetSlotsText(st, `❌ ${r.error} Ketik lagi.`), presetSlotsKb(st));
        return RETRY;
      }
      s.awaitingText = null;
      saveSettings(r.settings!);
      s.data.settingsMsgId = await upsert(ctx, s.data.settingsMsgId, presetSlotsText(r.settings!, "✅ Tersimpan — dipakai di panel /add."), presetSlotsKb(r.settings!));
    };
    const label = kind === "rp" ? `range % slot ${Number(slot) + 1} (0.1–99; SOL side = −X%, token = +X%, double = ±X%)` : `amount slot ${Number(slot) + 1} (SOL, > 0)`;
    s.data.settingsMsgId = await upsert(ctx, s.data.settingsMsgId, `✏️ Ketik nilai baru untuk ${label}.\nSekarang: ${cur ?? "-"}`, new InlineKeyboard().text("⬅️ Kembali", "st:pre"));
  });
  bot.callbackQuery("st:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    getSession(key(ctx)).awaitingText = null;
    await renderSettings(ctx);
  });
  bot.callbackQuery(/^st:edit:(swap|liq|presets|bins|prio|jupmax|pct|mix)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = getSession(key(ctx));
    s.data.settingsMsgId = ctx.callbackQuery.message?.message_id ?? s.data.settingsMsgId;
    const f = ctx.match![1];
    const back = new InlineKeyboard().text("⬅️ Kembali", "st:back");
    s.awaitingText = async (text) => {
      await deleteUserMsg(ctx);
      try {
        if (f === "prio" || f === "jupmax") {
          const raw = text.trim().toLowerCase();
          const n = raw === "auto" ? 0 : Math.floor(Number(raw));
          const max = f === "prio" ? 5_000_000 : 10_000_000;
          if (!Number.isFinite(n) || n < 0 || n > max) return retry(renderSettings(ctx, `Angka 0–${max}${f === "prio" ? " atau 'auto'" : ""}.`));
          const st = loadSettings();
          if (f === "prio") st.priorityFeeMicroLamports = n;
          else st.jupPriorityMaxLamports = n;
          saveSettings(st);
          return renderSettings(ctx, "Tersimpan.");
        }
        if (f === "pct") {
          const list = parsePctPresets(text);
          if (!list) return retry(renderSettings(ctx, "Format: dipisah koma, mis. `50, 70` atau `0-50, -40 +10` (maks 4)."));
          const st = loadSettings();
          st.rangePresets = list;
          saveSettings(st);
          return renderSettings(ctx, "Range % presets tersimpan (SOL side = turun, token side = naik).");
        }
        if (f === "mix") {
          const n = Math.round(Number(text.trim().replace("%", "").split(/[\/\s]/)[0]));
          if (!Number.isFinite(n) || n < 1 || n > 99) return retry(renderSettings(ctx, "Ketik % BidAsk 1–99 (contoh: 70 → 70/30)."));
          const st = loadSettings();
          st.mixBidAskPct = n;
          saveSettings(st);
          return renderSettings(ctx, `Mix ${n}/${100 - n} tersimpan.`);
        }
        if (f === "bins") {
          const bp = parseBinPresets(text);
          if (!bp) return retry(renderSettings(ctx, "Format: 3 angka bins 1–1399 (narrow medium wide), contoh: 20 40 69"));
          const st = loadSettings();
          st.binPresets = bp;
          saveSettings(st);
          return renderSettings(ctx, "Bin presets tersimpan (berlaku untuk panel /add berikutnya).");
        }
        if (f === "presets") {
          const arr = parsePresets(text);
          if (!arr) return retry(renderSettings(ctx, "Format presets: angka SOL dipisah spasi/koma, max 6. contoh: 0.5 1 2"));
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
      f === "prio"
        ? `Ketik priority fee DLMM dalam µlamports/CU (0 atau 'auto' = otomatis). Sekarang: ${loadSettings().priorityFeeMicroLamports || "auto"}`
        : f === "jupmax"
        ? `Ketik batas priority fee Jupiter per swap dalam lamports (0 = mati, 1000000 = 0.001 SOL). Sekarang: ${loadSettings().jupPriorityMaxLamports}`
        : f === "pct"
        ? `Ketik range % presets dipisah koma (maks 4), mis. \`50, 70\` atau \`0-50, -40 +10\`. Sekarang: ${loadSettings().rangePresets.map((r) => pctLabel(r)).join(", ")}`
        : f === "mix"
        ? `Ketik % BidAsk untuk strategi Mix (sisanya Spot), mis. 70. Sekarang: ${loadSettings().mixBidAskPct}`
        : f === "bins"
        ? `Ketik 3 angka bins narrow medium wide (1–1399). Sekarang: ${Object.values(loadSettings().binPresets).join(" ")}`
        : f === "presets"
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
  { command: "scan", description: "Scan pool DLMM SOL teratas (info saja)" },
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


// ---- per-slot preset editor (pure helpers exported for tests) ----
export const DEFAULT_AMOUNT_PRESETS = [0.5, 1, 2];

export function presetSlotsText(st: Settings, note?: string): string {
  const a = amountSlots(st);
  return [
    "**🎛 Tombol preset /add**",
    "",
    `Range %: ${st.rangePct.join("% · ")}%  (+ tombol Default 69 bin)`,
    `Amount: ${a.join(" · ")} SOL`,
    "",
    "Tap tombol untuk ganti nilainya.",
    note ? `\nℹ️ ${note}` : null,
  ].filter((x) => x !== null).join("\n");
}

export function amountSlots(st: Settings): number[] {
  const a = st.amountPresets.slice(0, 3);
  while (a.length < 3) a.push(DEFAULT_AMOUNT_PRESETS[a.length]);
  return a;
}

export function presetSlotsKb(st: Settings): InlineKeyboard {
  const kb = new InlineKeyboard();
  st.rangePct.forEach((v, i) => kb.text(`✏️ ${v}%`, `st:slot:rp:${i}`));
  kb.row();
  amountSlots(st).forEach((a, i) => kb.text(`✏️ ${a} SOL`, `st:slot:amt:${i}`));
  return kb.row().text("♻️ Reset default", "st:pre:reset").text("⬅️ Settings", "st:back");
}

export function applyPresetSlot(st: Settings, kind: "rp" | "amt", slot: string, text: string): { settings?: Settings; error?: string } {
  const n = Number(String(text).trim().replace(",", ".").replace(/(sol|%)$/i, "").replace(/^[-+±]/, "").trim());
  const next: Settings = { ...st, rangePct: [...st.rangePct], amountPresets: amountSlots(st) };
  if (kind === "rp") {
    const i = Number(slot);
    if (!(i >= 0 && i <= 3)) return { error: "Slot tidak dikenal." };
    if (!Number.isFinite(n) || n < 0.1 || n > 99) return { error: "Range % harus 0.1–99 (mis. 25)." };
    next.rangePct[i] = Math.round(n * 10) / 10;
  } else {
    const i = Number(slot);
    if (!(i >= 0 && i <= 2) || String(text).trim().startsWith("-")) return { error: "Slot tidak dikenal / Amount harus > 0." };
    if (!Number.isFinite(n) || n <= 0 || n > 100_000) return { error: "Amount harus angka SOL > 0 (mis. 0.25)." };
    next.amountPresets[i] = Math.round(n * 1e6) / 1e6;
  }
  return { settings: next };
}

export function resetPresetSlots(st: Settings): Settings {
  return { ...st, binPresets: { ...DEFAULT_BIN_PRESETS }, rangePct: [...DEFAULT_RANGE_PCT], amountPresets: [...DEFAULT_AMOUNT_PRESETS] };
}

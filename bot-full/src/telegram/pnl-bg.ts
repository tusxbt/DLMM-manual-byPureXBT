/**
 * Per-user PnL card background: DATA_DIR/users/<telegramId>/pnl-bg.jpg (owner too).
 * Upload → validate (image, ≤10MB) → cover-crop 1200x800 → JPEG. Env PNL_BG_PATH = global fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard, InputFile, type Bot, type Context } from "grammy";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { rootDataDir } from "../users/store.js";
import { currentUser } from "../users/context.js";
import { loadSettings, saveSettings } from "../store/settings.js";
import { renderPnlCard, preloadPnlBackground, type PnlCardData } from "../render/pnl-card.js";
import { getSession } from "./session.js";
import { log, redactSecrets } from "../logger.js";

export const BG_MAX_BYTES = 10 * 1024 * 1024;
export const BG_W = 1200;
export const BG_H = 800;
export const DARK_OPTS = [40, 60, 80];
export const BLUR_OPTS = [0, 6, 12];

export function userBgPath(userId = currentUser()?.userId): string | null {
  if (!userId || !/^\d+$/.test(userId)) return null;
  return path.join(rootDataDir(), "users", userId, "pnl-bg.jpg");
}

/** Background for the current user's cards: own upload, else env PNL_BG_PATH, else none. */
export function bgForCurrentUser(): { background: string | null; bgDarkPct: number; bgBlur: number; custom: boolean } {
  const st = loadSettings();
  const own = userBgPath();
  const custom = !!own && fs.existsSync(own);
  return { background: custom ? own : process.env.PNL_BG_PATH?.trim() || null, bgDarkPct: st.pnlBgDarkPct, bgBlur: st.pnlBgBlur, custom };
}

/** Validate + cover-crop to 1200x800 JPEG. Throws a user-facing message on bad input. */
export async function processBgImage(buf: Buffer, mime?: string): Promise<Buffer> {
  if (buf.length > BG_MAX_BYTES) throw new Error("File terlalu besar (maks 10MB).");
  if (mime && !/^image\/(jpeg|png|webp)$/i.test(mime)) throw new Error("Format harus JPG/PNG/WebP.");
  const sig = buf.subarray(0, 12);
  const isJpg = sig[0] === 0xff && sig[1] === 0xd8;
  const isPng = sig.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isWebp = sig.subarray(0, 4).toString() === "RIFF" && sig.subarray(8, 12).toString() === "WEBP";
  if (!isJpg && !isPng && !isWebp) throw new Error("Bukan gambar JPG/PNG/WebP.");
  let img;
  try {
    img = await loadImage(buf);
  } catch {
    throw new Error("Gambar tidak bisa dibaca.");
  }
  if (img.width < 200 || img.height < 200) throw new Error("Gambar terlalu kecil (min 200px).");
  const c = createCanvas(BG_W, BG_H);
  const ctx = c.getContext("2d");
  const k = Math.max(BG_W / img.width, BG_H / img.height);
  ctx.drawImage(img, (BG_W - img.width * k) / 2, (BG_H - img.height * k) / 2, img.width * k, img.height * k);
  return c.toBuffer("image/jpeg", 88);
}

export function saveUserBg(jpg: Buffer, userId = currentUser()?.userId): string {
  const p = userBgPath(userId);
  if (!p) throw new Error("User tidak dikenal.");
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, jpg, { mode: 0o600 });
  fs.renameSync(tmp, p);
  return p;
}

export function resetUserBg(userId = currentUser()?.userId): boolean {
  const p = userBgPath(userId);
  if (!p || !fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function sampleCardData(): PnlCardData {
  const t0 = Math.floor(Date.now() / 1000) - 4 * 3600;
  let px = 0.0000128;
  const candles = Array.from({ length: 48 }, (_, i) => {
    const o = px;
    px = px * (1 + Math.sin(i / 5) * 0.03 + (i > 30 ? 0.012 : -0.002));
    return { t: t0 + i * 300, o, c: px, h: Math.max(o, px), l: Math.min(o, px) };
  });
  return {
    pair: "RAM/SOL", position: "sample", closed: true, depositUsd: 552.12, exitUsd: 629.02, feesUsd: 76.45,
    pnlUsd: 76.9, pnlPct: 13.93, duration: "4j 12m", minPrice: 0.0000112, maxPrice: 0.0000146, exitPrice: px, candles,
    timeLabel: "preview", source: "Meteora", strategy: "Mix 70/30", bins: 69, exitLabel: "ZAPOUT",
  };
}

export async function renderPreviewPng(): Promise<Buffer> {
  const bg = bgForCurrentUser();
  await preloadPnlBackground(bg.background);
  return renderPnlCard({ ...sampleCardData(), ...bg });
}

function bgText(note?: string): string {
  const b = bgForCurrentUser();
  return [
    "**🖼 Background PnL card**",
    "",
    `Sumber: ${b.custom ? "foto kamu" : b.background ? "default server" : "polos (default)"}`,
    `Gelap: ${b.bgDarkPct}% · Blur: ${b.bgBlur}px`,
    note ? `\nℹ️ ${note}` : null,
  ].filter((x) => x !== null).join("\n");
}

function bgKb(): InlineKeyboard {
  const st = loadSettings();
  const kb = new InlineKeyboard().text("📤 Upload foto", "bg:up").text("👀 Preview", "bg:prev").row();
  for (const d of DARK_OPTS) kb.text(`${st.pnlBgDarkPct === d ? "✓ " : ""}Gelap ${d}%`, `bg:dark:${d}`);
  kb.row();
  for (const b of BLUR_OPTS) kb.text(`${st.pnlBgBlur === b ? "✓ " : ""}Blur ${b}`, `bg:blur:${b}`);
  return kb.row().text("♻️ Reset default", "bg:reset").text("⬅️ Settings", "st:back");
}

async function show(ctx: Context, note?: string): Promise<void> {
  const text = bgText(note);
  const opts = { reply_markup: bgKb() };
  if (ctx.callbackQuery?.message && !ctx.callbackQuery.message.photo) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch (e) {
      if (/not modified/i.test(String((e as Error).message))) return;
    }
  }
  await ctx.reply(text, opts);
}

const key = (ctx: Context) => String(ctx.chat?.id ?? "");

async function downloadTelegramFile(ctx: Context, fileId: string, token: string): Promise<Buffer> {
  const f = await ctx.api.getFile(fileId);
  if (f.file_size && f.file_size > BG_MAX_BYTES) throw new Error("File terlalu besar (maks 10MB).");
  if (!f.file_path) throw new Error("File tidak tersedia.");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
  if (!res.ok) throw new Error(`Download gagal (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > BG_MAX_BYTES) throw new Error("File terlalu besar (maks 10MB).");
  return buf;
}

export function registerPnlBgUi(bot: Bot, token: string): void {
  bot.callbackQuery("st:bg", async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx);
  });
  bot.callbackQuery("bg:up", async (ctx) => {
    await ctx.answerCallbackQuery();
    getSession(key(ctx)).data.awaitingBg = true;
    await show(ctx, "Kirim 1 foto (atau file gambar JPG/PNG/WebP, maks 10MB) sekarang.");
  });
  bot.callbackQuery(/^bg:(dark|blur):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const st = loadSettings();
    const n = Number(ctx.match![2]);
    if (ctx.match![1] === "dark" && DARK_OPTS.includes(n)) st.pnlBgDarkPct = n;
    if (ctx.match![1] === "blur" && BLUR_OPTS.includes(n)) st.pnlBgBlur = n;
    saveSettings(st);
    await show(ctx);
  });
  bot.callbackQuery("bg:reset", async (ctx) => {
    await ctx.answerCallbackQuery();
    const had = resetUserBg();
    getSession(key(ctx)).data.awaitingBg = false;
    await show(ctx, had ? "Background direset ke default." : "Sudah default.");
  });
  bot.callbackQuery("bg:prev", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Render preview…" });
    try {
      await ctx.replyWithPhoto(new InputFile(await renderPreviewPng(), "preview.png"), { caption: "👀 Preview PnL card (contoh angka)" });
    } catch (e) {
      await ctx.reply(`❌ ${redactSecrets((e as Error).message)}`);
    }
  });

  const onImage = async (ctx: Context, fileId: string, mime?: string, size?: number) => {
    const s = getSession(key(ctx));
    if (!s.data.awaitingBg) return false;
    s.data.awaitingBg = false;
    try {
      if (size && size > BG_MAX_BYTES) throw new Error("File terlalu besar (maks 10MB).");
      const raw = await downloadTelegramFile(ctx, fileId, token);
      saveUserBg(await processBgImage(raw, mime));
      await ctx.replyWithPhoto(new InputFile(await renderPreviewPng(), "preview.png"), { caption: "✅ Background disimpan. Preview ⬆️" });
      await show(ctx);
    } catch (e) {
      log("pnl_bg", redactSecrets((e as Error).message), "warn");
      await show(ctx, `❌ ${redactSecrets((e as Error).message)}`);
    }
    return true;
  };
  bot.on("message:photo", async (ctx, next) => {
    const sizes = ctx.message.photo;
    const big = sizes[sizes.length - 1]; // Telegram sorts ascending; last = largest
    if (!(await onImage(ctx, big.file_id, "image/jpeg", big.file_size))) await next();
  });
  bot.on("message:document", async (ctx, next) => {
    const d = ctx.message.document;
    if (!/^image\//i.test(d.mime_type || "")) {
      if (getSession(key(ctx)).data.awaitingBg) return void (await show(ctx, "❌ File harus gambar (JPG/PNG/WebP)."));
      return next();
    }
    if (!(await onImage(ctx, d.file_id, d.mime_type, d.file_size))) await next();
  });
}

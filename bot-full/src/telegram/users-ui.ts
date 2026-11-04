import { screen, section, kv } from "./layout.js";
/** 👛 Wallet (per user) + /admin (owner only). No key/seed is ever accepted or shown in chat. */
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { currentUser, runAsUser } from "../users/context.js";
import {
  listUsers, addUser, removeUser, ownerId, hasWallet, walletPubkeyOf, createWallet,
  hasImportFile, importWalletFromFile, importFile, NO_KEY_MSG,
} from "../users/store.js";
import { encryptionKey } from "../users/crypto.js";
import { getBalances, getConnection } from "../engine/connection.js";
import { getSolUsd } from "../engine/prices.js";
import { loadConfig, CONFIRM_TTL_MS } from "../config.js";
import { fmtNum, fmtUsd } from "../format.js";
import { getSession } from "./session.js";
import { createConfirm } from "../engine/confirm.js";
import { presentConfirm } from "./confirm-ui.js";
import { assertUsdCap } from "../engine/executor.js";
import type { PendingTxItem } from "../engine/pending.js";
import { log } from "../logger.js";

const chatKey = (ctx: Context) => String(ctx.chat?.id ?? "");
const isOwner = () => !!currentUser()?.isOwner;

/** Updates allowed for a non-owner without a wallet yet. */
export function allowedWithoutWallet(ctx: Context): boolean {
  const t = ctx.message?.text?.trim() || "";
  const d = ctx.callbackQuery?.data || "";
  return /^\/(start|menu|wallet|cancel)\b/.test(t) || t === "👛 Wallet" || t === "🏠 Home" || d.startsWith("w:") || d === "menu:cancel";
}

export async function showWallet(ctx: Context): Promise<void> {
  const me = currentUser();
  if (me && !me.isOwner && !hasWallet(me.userId)) {
    const kb = new InlineKeyboard().text("🆕 Buat wallet", "w:create");
    await ctx.reply(
      ["👛 **Wallet**", "Kamu belum punya wallet di bot ini.", "", "🆕 Buat wallet baru (key dibuat & dienkripsi di server), atau minta owner import wallet lewat file di VPS.", "⚠️ Bot tidak pernah meminta private key / seed di chat."].join("\n"),
      { reply_markup: kb },
    );
    return;
  }
  let solUsd = 0;
  try {
    solUsd = await getSolUsd();
  } catch {
    /* n/a */
  }
  const b = await getBalances(solUsd);
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const u = (x: number) => (solUsd ? fmtUsd(x) : "n/a");
  const kb = new InlineKeyboard().text("🔄 Refresh", "w:show").text("📤 Withdraw SOL", "w:wd");
  if (isOwner()) kb.row().text("🛡 Admin", "adm:home");
  await ctx.reply(
    walletText({ wallet: b.wallet, sol: b.sol, solUsd: solUsd ? b.sol_usd : null, usdc: b.usdc, totalUsd: solUsd ? b.total_usd : null, owner: isOwner(), dryRun: cfg.dryRun, capPos: cfg.maxPositionUsd, capSwap: cfg.maxSwapUsd, error: b.error }),
    { reply_markup: kb },
  );
}

export const ONBOARD_TEXT = [
  "👋 **Selamat datang di DLMM bot!**",
  "Owner sudah memberi kamu akses.",
  "",
  "Langkah 1: tekan 🆕 Buat wallet — wallet baru dibuat & dienkripsi di server, lalu deposit SOL ke alamatnya.",
  "Atau: owner bisa import wallet lama kamu lewat file di VPS (bukan lewat chat).",
  "",
  "⚠️ Jangan pernah kirim private key / seed phrase di chat. Bot tidak akan memintanya.",
].join("\n");
export const onboardKb = () => new InlineKeyboard().text("🆕 Buat wallet", "w:create");

export function walletText(w: {
  wallet: string; sol: number; solUsd: number | null; usdc: number; totalUsd: number | null;
  owner: boolean; dryRun: boolean; capPos: number; capSwap: number; error?: string;
}): string {
  return screen(
    `👛 Wallet${w.owner ? " · owner" : ""}`,
    section(null, [`\`${w.wallet}\``, `[Solscan](https://solscan.io/account/${w.wallet})`]),
    section("💰 Saldo", [
      kv("SOL", `${fmtNum(w.sol)}${w.solUsd != null ? ` (${fmtUsd(w.solUsd)})` : ""}`),
      kv("USDC", fmtNum(w.usdc)),
      kv("Total", w.totalUsd == null ? "n/a" : fmtUsd(w.totalUsd)),
    ]),
    section("🔒 Batas", [kv("Mode", w.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"), kv("Cap posisi", fmtUsd(w.capPos)), kv("Cap swap", fmtUsd(w.capSwap))]),
    w.error ? `⚠️ ${w.error}` : null,
  );
}

// ── withdraw ──
export async function buildWithdrawTx(from: PublicKey, to: PublicKey, lamports: number): Promise<PendingTxItem> {
  const conn = getConnection();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
  tx.feePayer = from;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  return { serialized: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), encoding: "legacy", label: "withdraw" };
}

async function askWithdraw(ctx: Context): Promise<void> {
  const s = getSession(chatKey(ctx));
  await ctx.reply("📤 Kirim **alamat tujuan** SOL (ketik / paste address). /cancel untuk batal.");
  s.awaitingText = async (addrText: string) => {
    let to: PublicKey;
    try {
      to = new PublicKey(addrText.trim());
    } catch {
      await ctx.reply("❌ Alamat tidak valid.");
      return;
    }
    await ctx.reply("Jumlah SOL? (angka, atau `max`)");
    s.awaitingText = async (amtText: string) => {
      try {
        const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
        const bal = (await getBalances(0)).sol;
        const fee = 0.00001;
        const amt = /^max$/i.test(amtText.trim()) ? Math.max(0, bal - fee) : Number(amtText.replace(",", "."));
        if (!Number.isFinite(amt) || amt <= 0) throw new Error("Jumlah tidak valid");
        if (amt > bal - fee + 1e-12) throw new Error(`Saldo kurang (${fmtNum(bal)} SOL)`);
        const usd = amt * (await getSolUsd());
        assertUsdCap("swap", usd);
        const lamports = Math.floor(amt * LAMPORTS_PER_SOL);
        const summary = [`📤 Withdraw **${fmtNum(amt)} SOL** (≈${fmtUsd(usd)})`, `→ \`${to.toBase58()}\``, `${cfg.dryRun ? "🧪 DRY_RUN" : "⚠️ LIVE"} · konfirmasi ${CONFIRM_TTL_MS / 1000}s`].join("\n");
        const req = createConfirm({ purpose: "withdraw", summary, payload: { to: to.toBase58(), lamports, usd } });
        await presentConfirm(ctx, summary, req.id);
      } catch (e) {
        await ctx.reply(`❌ ${(e as Error).message}`);
      }
    };
  };
}

// ── admin ──
export function adminText(): string {
  const users = listUsers();
  return screen(
    "🛡 Admin",
    section(null, [kv("Owner", `\`${ownerId()}\``), kv("Enkripsi", encryptionKey() ? "✅ key diset" : "❌ belum diset")]),
    section(`👥 User (${users.length})`, users.length
      ? users.map((u) => {
          const pk = walletPubkeyOf(u.id);
          return [`\`${u.id}\``, pk ? `  👛 \`${pk}\`` : "  👛 belum ada", hasImportFile(u.id) ? "  📥 file import siap" : null].filter(Boolean).join("\n");
        })
      : ["Belum ada user tambahan."]),
  );
}

function adminKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Tambah user", "adm:add").text("➖ Hapus user", "adm:rm").row()
    .text("📋 List + saldo", "adm:list").text("📥 Import dari file VPS", "adm:imp");
}

async function showAdmin(ctx: Context): Promise<void> {
  await ctx.reply(adminText(), { reply_markup: adminKb() });
}

function pickKb(prefix: string, filter: (id: string) => boolean = () => true): InlineKeyboard {
  const kb = new InlineKeyboard();
  listUsers().filter((u) => filter(u.id)).forEach((u) => kb.text(u.id, `${prefix}:${u.id}`).row());
  return kb.text("← Admin", "adm:home");
}

export function registerUsersUi(bot: Bot): void {
  bot.command("wallet", showWallet);
  bot.callbackQuery("w:show", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showWallet(ctx);
  });
  bot.callbackQuery("w:create", async (ctx) => {
    await ctx.answerCallbackQuery();
    const me = currentUser();
    if (!me || me.isOwner) return;
    if (!encryptionKey()) {
      await ctx.reply("❌ Wallet belum bisa dibuat: server belum diset kunci enkripsi. Minta owner set WALLET_ENCRYPTION_KEY.");
      const oid = ownerId();
      if (oid) await ctx.api.sendMessage(oid, `⚠️ User \`${me.userId}\` mencoba buat wallet. ${NO_KEY_MSG}`).catch(() => undefined);
      return;
    }
    try {
      const pk = createWallet(me.userId);
      log("users", `wallet created user=${me.userId} pub=${pk}`);
      await ctx.reply(`✅ Wallet dibuat\n\`${pk}\`\nDeposit SOL ke alamat ini untuk mulai.`);
      await showWallet(ctx);
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`);
    }
  });
  bot.callbackQuery("w:wd", async (ctx) => {
    await ctx.answerCallbackQuery();
    await askWithdraw(ctx);
  });

  const ownerOnly = async (ctx: Context, fn: () => Promise<void>) => {
    if (!isOwner()) {
      await ctx.reply("⛔ Khusus owner.");
      return;
    }
    await fn();
  };
  bot.command("admin", (ctx) => ownerOnly(ctx, () => showAdmin(ctx)));
  bot.callbackQuery("adm:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ownerOnly(ctx, () => showAdmin(ctx));
  });
  bot.callbackQuery("adm:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ownerOnly(ctx, async () => {
      const s = getSession(chatKey(ctx));
      await ctx.reply("➕ Kirim **Telegram user ID** (angka). /cancel untuk batal.");
      s.awaitingText = async (t: string) => {
        const id = t.trim();
        try {
          const ok = addUser(id);
          await ctx.reply(ok ? `✅ User \`${id}\` ditambahkan.` : `ℹ️ \`${id}\` sudah terdaftar / owner.`);
          if (ok && !hasWallet(id)) {
            try {
              await ctx.api.sendMessage(id, ONBOARD_TEXT, { reply_markup: onboardKb() });
              await ctx.reply("📨 Pesan onboarding terkirim ke user.");
            } catch {
              await ctx.reply("⚠️ Gagal DM user (belum pernah /start bot). Minta dia buka bot & ketik /start — onboarding muncul otomatis.");
            }
          }
        } catch (e) {
          await ctx.reply(`❌ ${(e as Error).message}`);
        }
        await showAdmin(ctx);
      };
    });
  });
  bot.callbackQuery("adm:rm", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ownerOnly(ctx, () => ctx.reply("➖ Pilih user untuk dihapus aksesnya (file wallet terenkripsi tetap disimpan):", { reply_markup: pickKb("adm:rm") }).then(() => undefined));
  });
  bot.callbackQuery(/^adm:rm:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ownerOnly(ctx, async () => {
      await ctx.reply(removeUser(ctx.match![1]) ? `✅ Akses \`${ctx.match![1]}\` dicabut.` : "Tidak ditemukan (user dari .env harus dihapus di .env).");
      await showAdmin(ctx);
    });
  });
  bot.callbackQuery("adm:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ownerOnly(ctx, async () => {
      const lines: string[] = ["📋 **Users**"];
      for (const u of listUsers()) {
        const pk = walletPubkeyOf(u.id);
        let bal = "—";
        if (pk) {
          try {
            bal = `${fmtNum((await getConnection().getBalance(new PublicKey(pk))) / LAMPORTS_PER_SOL)} SOL`;
          } catch {
            bal = "n/a";
          }
        }
        lines.push(`• \`${u.id}\`\n  ${pk ? `\`${pk}\`` : "belum ada wallet"} · ${bal}`);
      }
      if (lines.length === 1) lines.push("Belum ada user tambahan.");
      await ctx.reply(lines.join("\n"), { reply_markup: new InlineKeyboard().text("← Admin", "adm:home") });
    });
  });
  bot.callbackQuery("adm:imp", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ownerOnly(ctx, async () => {
      const ready = listUsers().filter((u) => hasImportFile(u.id));
      if (!ready.length) {
        await ctx.reply(
          ["📥 Belum ada file import.", "Taruh keypair di VPS:", `\`${importFile("<userId>")}\``, "(JSON array 64 angka, atau base58) lalu tekan tombol ini lagi."].join("\n"),
          { reply_markup: new InlineKeyboard().text("← Admin", "adm:home") },
        );
        return;
      }
      await ctx.reply("📥 Pilih user untuk import (file plaintext akan dihapus aman setelah dienkripsi):", { reply_markup: pickKb("adm:imp", (id) => hasImportFile(id)) });
    });
  });
  bot.callbackQuery(/^adm:imp:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ownerOnly(ctx, async () => {
      const id = ctx.match![1];
      try {
        const pk = importWalletFromFile(id);
        log("users", `wallet imported user=${id} pub=${pk}`);
        await ctx.reply(`✅ Wallet \`${id}\` diimport\n\`${pk}\`\n🗑 File import plaintext sudah dihapus.`);
        await ctx.api.sendMessage(id, `👛 Wallet kamu sudah aktif:\n\`${pk}\``).catch(() => undefined);
      } catch (e) {
        await ctx.reply(`❌ ${(e as Error).message}`);
      }
      await showAdmin(ctx);
    });
  });
}

export { runAsUser };

import type { Context } from "grammy";
import { loadConfig } from "../config.js";

/**
 * Only Telegram user IDs listed in ALLOWED_TELEGRAM_USER_IDS may control the bot.
 * Everyone else is ignored (no reply).
 */
export function isAuthorized(ctx: Context): boolean {
  const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
  const uid = ctx.from?.id != null ? String(ctx.from.id) : "";
  if (!uid || cfg.allowedUserIds.size === 0) return false;
  if (!cfg.allowedUserIds.has(uid)) return false;
  // Optional chat filter when TELEGRAM_CHAT_ID is set to a real id
  if (cfg.telegramChatId && cfg.telegramChatId !== "0") {
    const chatId = String(ctx.chat?.id ?? "");
    if (chatId && chatId !== cfg.telegramChatId) return false;
  }
  return true;
}

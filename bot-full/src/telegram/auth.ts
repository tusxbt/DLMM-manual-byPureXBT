import type { Context } from "grammy";
import { loadConfig } from "../config.js";
import { roleOf, type Role } from "../users/store.js";

/** owner (OWNER_TELEGRAM_ID or first ALLOWED id) | user (ALLOWED or users.json) | null. */
export function roleFor(ctx: Context): Role {
  const uid = ctx.from?.id != null ? String(ctx.from.id) : "";
  const role = roleOf(uid);
  if (!role) return null;
  const chatId = String(ctx.chat?.id ?? "");
  // private chat with the user themself is always OK; other chats must match TELEGRAM_CHAT_ID
  if (chatId && chatId !== uid) {
    const cfg = loadConfig({ requireTelegram: false, skipWallet: true });
    if (!cfg.telegramChatId || cfg.telegramChatId === "0" || chatId !== cfg.telegramChatId) return null;
  }
  return role;
}

export function isAuthorized(ctx: Context): boolean {
  return roleFor(ctx) != null;
}

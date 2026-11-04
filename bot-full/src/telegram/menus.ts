import { InlineKeyboard } from "grammy";

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🚀 Add LP", "menu:add")
    .text("📊 Positions", "menu:positions")
    .row()
    .text("💸 Claim", "menu:claim")
    .text("🚪 Remove", "menu:remove")
    .row()
    .text("🔄 Swap", "menu:swap")
    .text("♻️ Reshape", "menu:reshape")
    .row()
    .text("💰 Balance", "menu:balance")
    .text("⚙️ Settings", "menu:settings")
    .row()
    .text("🔍 Pools", "menu:pools");
}

export const CANCEL_KB = new InlineKeyboard().text("❌ Batal", "menu:cancel");

export function confirmKeyboard(confirmId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm", `confirm:yes:${confirmId}`)
    .text("❌ Cancel", `confirm:no:${confirmId}`);
}

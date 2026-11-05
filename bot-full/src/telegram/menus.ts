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
    .text("⚡ Zapout", "menu:zapout")
    .text("💰 Balance", "menu:balance")
    .row()
    .text("⚙️ Settings", "menu:settings")
    .text("🔍 Pools", "menu:pools")
    .row()
    .text("📜 Riwayat", "menu:history");
}

export const CANCEL_KB = new InlineKeyboard().text("❌ Batal", "menu:cancel");

export function confirmKeyboard(confirmId: string, opts: { back?: boolean } = {}): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("✅ Confirm", `confirm:yes:${confirmId}`)
    .text("❌ Cancel", `confirm:no:${confirmId}`);
  // /add Preview: back to the (same-message) setup panel, settings preserved
  if (opts.back) kb.row().text("⬅️ Kembali", `ap:pvback:${confirmId}`);
  return kb;
}

/** In-place /add panel: back to setup + preview again. */
export function addBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("⬅️ Kembali", "ap:back").text("👀 Preview lagi", "ap:deploy");
}

/**
 * Present a Confirm/Cancel prompt — or, when Auto confirm is ON, execute immediately.
 * Safeguards (whitelist, USD caps, DRY_RUN, signer checks) live in the executor path,
 * so they apply identically in both modes.
 */
import type { Context } from "grammy";
import { confirmKeyboard } from "./menus.js";
import { loadSettings, saveSettings } from "../store/settings.js";
import { takeAwaiting, type ConfirmRequest } from "../engine/confirm.js";

type Runner = (ctx: Context, req: ConfirmRequest) => Promise<void>;
let runner: Runner | null = null;

export function setConfirmRunner(fn: Runner): void {
  runner = fn;
}

export function isAutoConfirm(): boolean {
  return loadSettings().autoConfirm === true;
}

export function setAutoConfirm(on: boolean): void {
  const s = loadSettings();
  s.autoConfirm = on;
  saveSettings(s);
}

export const AUTO_BADGE = "⚡ Auto confirm ON";

export async function presentConfirm(
  ctx: Context,
  text: string,
  confirmId: string,
  opts: { edit?: boolean } = {},
): Promise<"prompted" | "auto"> {
  if (isAutoConfirm() && runner) {
    const req = takeAwaiting(confirmId);
    if (req && req.status === "awaiting") {
      await ctx.reply(`${text}\n\n${AUTO_BADGE} — langsung dieksekusi.`, { link_preview_options: { is_disabled: true } });
      await runner(ctx, req);
      return "auto";
    }
  }
  if (opts.edit) await ctx.editMessageText(text, { reply_markup: confirmKeyboard(confirmId) });
  else await ctx.reply(text, { reply_markup: confirmKeyboard(confirmId) });
  return "prompted";
}

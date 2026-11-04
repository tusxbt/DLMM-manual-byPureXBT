/**
 * Present a Confirm/Cancel prompt — or, when Auto confirm is ON, execute immediately.
 * Safeguards (whitelist, USD caps, DRY_RUN, signer checks) live in the executor path,
 * so they apply identically in both modes.
 */
import type { Context } from "grammy";
import { confirmKeyboard } from "./menus.js";
import { loadSettings, saveSettings } from "../store/settings.js";
import { takeAwaiting, type ConfirmRequest } from "../engine/confirm.js";

type Runner = (ctx: Context, req: ConfirmRequest, statusMsgId?: number) => Promise<void>;
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

export const AUTO_BADGE = "⚡ Auto confirm close ON";

/** Only closing actions may skip Confirm. Everything else always prompts. */
export const AUTO_CONFIRM_PURPOSES: ReadonlyArray<ConfirmRequest["purpose"]> = ["remove", "zapout"];

export function canAutoConfirm(purpose: ConfirmRequest["purpose"]): boolean {
  return isAutoConfirm() && AUTO_CONFIRM_PURPOSES.includes(purpose);
}

export async function presentConfirm(
  ctx: Context,
  text: string,
  confirmId: string,
  opts: { edit?: boolean; msgId?: number; back?: boolean } = {},
): Promise<"prompted" | "auto"> {
  if (isAutoConfirm() && runner) {
    const req = takeAwaiting(confirmId);
    if (req && req.status === "awaiting" && canAutoConfirm(req.purpose)) {
      // compact: one status message (reuse msgId if given) — the runner edits it through stages
      const status = `⏳ ${text.split("\n")[0]} · ⚡ auto`;
      let id = opts.msgId;
      if (id) {
        try {
          await ctx.api.editMessageText(ctx.chat!.id, id, status);
        } catch {
          id = undefined;
        }
      }
      if (!id) id = (await ctx.reply(status)).message_id;
      await runner(ctx, req, id);
      return "auto";
    }
  }
  if (opts.msgId) {
    try {
      await ctx.api.editMessageText(ctx.chat!.id, opts.msgId, text, { reply_markup: confirmKeyboard(confirmId, { back: opts.back }) });
      return "prompted";
    } catch {
      /* fall through */
    }
  }
  const kb = confirmKeyboard(confirmId, { back: opts.back });
  if (opts.edit) await ctx.editMessageText(text, { reply_markup: kb });
  else await ctx.reply(text, { reply_markup: kb });
  return "prompted";
}

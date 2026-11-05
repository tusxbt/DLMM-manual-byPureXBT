import type { AddPanelState } from "./add-panel.js";

export type WizardData = {
  pools?: Array<Record<string, unknown>>;
  pool?: Record<string, unknown>;
  strategyId?: string;
  side?: "one_sided_sol" | "two_sided";
  amountSol?: number;
  amountToken?: number;
  rangePresetId?: string;
  binsBelow?: number;
  binsAbove?: number;
  downPct?: number;
  upPct?: number;
  posList?: Array<Record<string, unknown>>;
  swapInputMint?: string;
  swapOutputMint?: string;
  swapAmount?: number;
  reshapeAnalysis?: Record<string, unknown>;
  reshapeWidth?: number;
  reshapeStrategyId?: string;
  panel?: AddPanelState;
  panelMsgId?: number;
  settingsMsgId?: number;
  /** waiting for a PnL background photo from this user */
  awaitingBg?: boolean;
  /** separate bot prompt messages ("ketik …") to delete once the user answers */
  promptMsgIds?: number[];
  posPage?: number;
};

export type Session = {
  step: string | null;
  data: WizardData;
  awaitingText: ((text: string) => Promise<unknown>) | null;
};

const sessions = new Map<string, Session>();
import { currentUser } from "../users/context.js";
const k = (chatId: string) => `${currentUser()?.userId ?? "-"}:${chatId}`;

export function getSession(chatId: string): Session {
  let s = sessions.get(k(chatId));
  if (!s) {
    s = { step: null, data: {}, awaitingText: null };
    sessions.set(k(chatId), s);
  }
  return s;
}

export function resetSession(chatId: string): void {
  sessions.set(k(chatId), { step: null, data: {}, awaitingText: null });
}

/** Snapshot of the session at the start of a long action. */
export type SessionMark = { obj: Session; step: unknown; awaiting: unknown; panel: unknown; keys: string };
export function markSession(chatId: string): SessionMark {
  const s = getSession(chatId);
  return { obj: s, step: s.step, awaiting: s.awaitingText, panel: (s.data as Record<string, unknown>).panel, keys: Object.keys(s.data).sort().join(",") };
}
/**
 * Reset only if the user did not start something else meanwhile (e.g. pasted a CA / opened
 * the /add panel while a zapout was running) — concurrent flows must not clobber each other.
 */
export function resetSessionIfUnchanged(chatId: string, m: SessionMark): boolean {
  const s = sessions.get(k(chatId));
  if (!s) return false;
  const same = s === m.obj && s.step === m.step && s.awaitingText === m.awaiting && (s.data as Record<string, unknown>).panel === m.panel && Object.keys(s.data).sort().join(",") === m.keys;
  if (same) resetSession(chatId);
  return same;
}

/** Return from an awaitingText handler to keep waiting for another try (invalid input). */
export const RETRY = Symbol("retry-input");

/** Send a separate prompt message and remember it so it is deleted after the user answers. */
export async function askPrompt(
  ctx: { chat?: { id: number }; reply: (t: string, o?: Record<string, unknown>) => Promise<{ message_id: number }> },
  chatId: string,
  text: string,
  opts?: Record<string, unknown>,
): Promise<void> {
  const m = await ctx.reply(text, opts);
  const s = getSession(chatId);
  (s.data.promptMsgIds ??= []).push(m.message_id);
}

/**
 * Run the pending text-input handler for a typed message: delete the user's message and any
 * separate prompt messages (ignore errors — bots can delete user msgs < 48h in private chats),
 * keep waiting when the handler returns RETRY. Not counted as a "new message" reset.
 */
export async function runAwaitingInput(
  chatId: string,
  text: string,
  api: { deleteMessage: (chat: number | string, id: number) => Promise<unknown> },
  chat: number | string,
  userMsgId: number,
): Promise<boolean> {
  const s = getSession(chatId);
  const fn = s.awaitingText;
  if (!fn) return false;
  s.awaitingText = null;
  const del = async (id: number) => {
    try {
      await api.deleteMessage(chat, id);
    } catch {
      /* ignore: too old / no rights */
    }
  };
  await del(userMsgId);
  const prompts = s.data.promptMsgIds ?? [];
  s.data.promptMsgIds = [];
  let r: unknown;
  try {
    r = await fn(text);
  } finally {
    // delete old prompts after the handler ran (a handler may send a follow-up prompt; keep that one)
    for (const id of prompts) await del(id);
  }
  if (r === RETRY && !s.awaitingText) s.awaitingText = fn;
  return true;
}

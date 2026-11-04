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

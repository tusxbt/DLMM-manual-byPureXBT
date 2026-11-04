/**
 * Confirm/Cancel gate for every signing action. 60s TTL. No auto/scheduled trades.
 */
import crypto from "node:crypto";
import { CONFIRM_TTL_MS } from "../config.js";
import { log } from "../logger.js";
import { currentUser } from "../users/context.js";

export type ConfirmPurpose = "add" | "remove" | "claim" | "swap" | "reshape" | "zapout" | "withdraw";

export type ConfirmRequest = {
  id: string;
  purpose: ConfirmPurpose;
  summary: string;
  createdAt: number;
  expiresAt: number;
  /** Opaque payload for the executor — must NOT contain private keys. */
  payload: Record<string, unknown>;
  status: "awaiting" | "confirmed" | "cancelled" | "expired" | "executed" | "failed";
  resultMessage?: string;
  /** Telegram user that created it; only that user can confirm/see it. */
  userId?: string;
};

const store = new Map<string, ConfirmRequest>();

export function createConfirm(input: {
  purpose: ConfirmPurpose;
  summary: string;
  payload: Record<string, unknown>;
  ttlMs?: number;
}): ConfirmRequest {
  purge();
  const id = crypto.randomBytes(6).toString("hex");
  const now = Date.now();
  const req: ConfirmRequest = {
    id,
    purpose: input.purpose,
    summary: input.summary,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? CONFIRM_TTL_MS),
    payload: input.payload,
    status: "awaiting",
    userId: currentUser()?.userId,
  };
  store.set(id, req);
  log("confirm", `awaiting ${id} purpose=${input.purpose} ttl=${input.ttlMs ?? CONFIRM_TTL_MS}ms`);
  return req;
}

export function getConfirm(id: string): ConfirmRequest | null {
  purge();
  const r = store.get(id) || null;
  if (!r) return null;
  const me = currentUser()?.userId;
  if (r.userId !== me) return null; // isolation: other users' confirms are invisible
  if (r.status === "awaiting" && r.expiresAt < Date.now()) {
    r.status = "expired";
  }
  return r;
}

export function markConfirm(id: string, status: ConfirmRequest["status"], resultMessage?: string): ConfirmRequest | null {
  const r = getConfirm(id);
  if (!r) return null;
  r.status = status;
  if (resultMessage) r.resultMessage = resultMessage;
  return r;
}

export function cancelConfirm(id: string): boolean {
  const r = getConfirm(id);
  if (!r || r.status !== "awaiting") return false;
  r.status = "cancelled";
  store.delete(id);
  return true;
}

export function takeAwaiting(id: string): ConfirmRequest | null {
  const r = getConfirm(id);
  if (!r) return null;
  if (r.status === "expired") return r;
  if (r.status !== "awaiting") return null;
  if (r.expiresAt < Date.now()) {
    r.status = "expired";
    return r;
  }
  return r;
}

function purge(): void {
  const now = Date.now();
  for (const [id, r] of store) {
    if (r.status === "awaiting" && r.expiresAt < now) {
      r.status = "expired";
    }
    // Keep expired briefly so callers can report timeout; drop old terminal states.
    if (r.status !== "awaiting" && now - r.createdAt > 10 * 60_000) {
      store.delete(id);
    }
  }
}

export function resetConfirmStoreForTests(): void {
  store.clear();
}

export function listAwaiting(): ConfirmRequest[] {
  purge();
  return [...store.values()].filter((r) => r.status === "awaiting" && r.userId === currentUser()?.userId);
}

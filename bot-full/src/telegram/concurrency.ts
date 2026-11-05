/**
 * Concurrent update handling.
 *
 * grammY's built-in long polling (bot.start) awaits every update before taking the next one, so
 * a 5–10 s zapout blocked EVERYTHING (other positions, pasting a CA, other users). This
 * middleware detaches handling from the polling loop:
 *  - callback queries (buttons) run immediately and concurrently;
 *  - messages (typed text, pasted CA, commands) stay ordered per chat, so text-input steps
 *    never race each other — but they no longer wait for button actions (close/zapout/…).
 * Duplicate actions on the SAME position are blocked by positionLock().
 */
import type { Context, MiddlewareFn } from "grammy";
import { log, redactSecrets } from "../logger.js";

const chains = new Map<string, Promise<void>>();

export function concurrentUpdates(onError: (e: unknown, ctx: Context) => void = defaultErr): MiddlewareFn<Context> {
  return (ctx, next) => {
    const run = () => next().catch((e) => onError(e, ctx));
    if (ctx.callbackQuery || !ctx.chat) {
      void run();
      return Promise.resolve();
    }
    const key = String(ctx.chat.id);
    const prev = chains.get(key) ?? Promise.resolve();
    const cur = prev.then(run, run);
    chains.set(key, cur);
    void cur.finally(() => {
      if (chains.get(key) === cur) chains.delete(key);
    });
    return Promise.resolve();
  };
}

function defaultErr(e: unknown): void {
  log("bot", redactSecrets(String((e as { error?: unknown })?.error ?? e)), "error");
}

// ── per-position locks (user-scoped key) ──
const locks = new Set<string>();

/** true if acquired; release with releasePosition. */
export function lockPosition(key: string): boolean {
  if (locks.has(key)) return false;
  locks.add(key);
  return true;
}
export function releasePosition(key: string): void {
  locks.delete(key);
}
export function isPositionLocked(key: string): boolean {
  return locks.has(key);
}

// ── per-key async mutex (queues instead of rejecting) ──
const queues = new Map<string, Promise<unknown>>();
/**
 * Run fn exclusively for `key` (others with the same key wait their turn). Used per token mint:
 * zapout / Claim+Sell measure "balance after − balance before" and swap that delta, so two
 * closes of the SAME token at once must not overlap (else one delta includes the other's tokens).
 */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const cur = prev.then(fn, fn);
  const tail = cur.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return cur;
}

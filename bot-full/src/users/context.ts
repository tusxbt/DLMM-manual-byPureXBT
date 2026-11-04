/** Per-request user scope (AsyncLocalStorage). Everything wallet/data related reads from here. */
import { AsyncLocalStorage } from "node:async_hooks";

export type UserScope = { userId: string; isOwner: boolean };
const als = new AsyncLocalStorage<UserScope>();

export function runAsUser<T>(scope: UserScope, fn: () => T): T {
  return als.run(scope, fn);
}
export function currentUser(): UserScope | undefined {
  return als.getStore();
}
/** Non-owner user id in scope, else null (owner / no scope = legacy single-user behaviour). */
export function scopedNonOwner(): string | null {
  const u = als.getStore();
  return u && !u.isOwner ? u.userId : null;
}

/** Mint decimals: SDK TokenReserve.mint.decimals first, then on-chain mint (cached). Never guessed. */
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./connection.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const cache = new Map<string, number>([[SOL_MINT, 9]]);

/** Read decimals from an SDK TokenReserve-like object (`{ mint: { decimals } }`) without network. */
export function decimalsFromReserve(r: unknown): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (r as any)?.mint?.decimals;
  return Number.isInteger(d) && d >= 0 && d <= 18 ? Number(d) : null;
}

export async function getMintDecimals(mint: string | PublicKey, reserve?: unknown): Promise<number> {
  const key = typeof mint === "string" ? mint : mint.toBase58();
  const fromReserve = decimalsFromReserve(reserve);
  if (fromReserve != null) {
    cache.set(key, fromReserve);
    return fromReserve;
  }
  const c = cache.get(key);
  if (c != null) return c;
  const info = await getConnection().getParsedAccountInfo(new PublicKey(key));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (info.value?.data as any)?.parsed?.info?.decimals;
  if (!Number.isInteger(d)) throw new Error(`Decimals mint ${key.slice(0, 6)}… tidak terbaca`);
  cache.set(key, d);
  return d;
}

export function setDecimalsForTests(mint: string, d: number): void {
  cache.set(mint, d);
}

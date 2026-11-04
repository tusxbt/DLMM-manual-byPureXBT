import { PublicKey } from "@solana/web3.js";

const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Detect a pasted Solana mint / CA. Returns base58 string or null. */
export function detectMintAddress(text: string): string | null {
  const t = text.trim();
  if (!BASE58_MINT_RE.test(t)) return null;
  try {
    const pk = new PublicKey(t);
    // Reject obviously wrong lengths after decode
    if (pk.toBytes().length !== 32) return null;
    return pk.toBase58();
  } catch {
    return null;
  }
}

export function isLikelyMintPaste(text: string): boolean {
  return detectMintAddress(text) != null;
}

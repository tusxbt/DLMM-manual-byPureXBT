/**
 * Pure helpers for /reshape — no RPC, no keys.
 * Token side = non-SOL mint in the pair (usually X when Y is SOL).
 */

export type BinAmounts = {
  binId: number;
  /** raw atomic strings from SDK */
  positionXAmount: string;
  positionYAmount: string;
  positionFeeXAmount?: string;
  positionFeeYAmount?: string;
};

export type BinKind = "sol_only" | "token_only" | "both" | "empty";

export type ClassifiedBin = {
  binId: number;
  kind: BinKind;
  tokenAtomic: bigint;
  solAtomic: bigint;
};

export function toBigIntAmount(v: string | number | bigint | null | undefined): bigint {
  if (v == null) return 0n;
  if (typeof v === "bigint") return v < 0n ? 0n : v;
  const s = String(v).split(".")[0] || "0";
  if (!/^-?\d+$/.test(s)) return 0n;
  try {
    const n = BigInt(s);
    return n < 0n ? 0n : n;
  } catch {
    return 0n;
  }
}

/** Classify a bin given which mint index is SOL (x or y). */
export function classifyBin(bin: BinAmounts, solSide: "x" | "y"): ClassifiedBin {
  const x = toBigIntAmount(bin.positionXAmount);
  const y = toBigIntAmount(bin.positionYAmount);
  const tokenAtomic = solSide === "y" ? x : y;
  const solAtomic = solSide === "y" ? y : x;
  let kind: BinKind = "empty";
  if (tokenAtomic > 0n && solAtomic > 0n) kind = "both";
  else if (tokenAtomic > 0n) kind = "token_only";
  else if (solAtomic > 0n) kind = "sol_only";
  return { binId: bin.binId, kind, tokenAtomic, solAtomic };
}

/** Bins that should be withdrawn for reshape (token_only + both). */
export function isTokenBearing(kind: BinKind): boolean {
  return kind === "token_only" || kind === "both";
}

/**
 * Merge sorted bin ids into contiguous [from, to] ranges (inclusive).
 */
export function contiguousRanges(binIds: number[]): Array<{ from: number; to: number }> {
  const ids = [...new Set(binIds)].filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  if (!ids.length) return [];
  const out: Array<{ from: number; to: number }> = [];
  let from = ids[0];
  let prev = ids[0];
  for (let i = 1; i < ids.length; i++) {
    const id = ids[i];
    if (id === prev + 1) {
      prev = id;
      continue;
    }
    out.push({ from, to: prev });
    from = id;
    prev = id;
  }
  out.push({ from, to: prev });
  return out;
}

export function classifyPositionBins(
  bins: BinAmounts[],
  solSide: "x" | "y",
): {
  classified: ClassifiedBin[];
  tokenBins: ClassifiedBin[];
  tokenRanges: Array<{ from: number; to: number }>;
  totalTokenAtomic: bigint;
  totalSolInTokenBinsAtomic: bigint;
  bothCount: number;
} {
  const classified = bins.map((b) => classifyBin(b, solSide));
  const tokenBins = classified.filter((b) => isTokenBearing(b.kind));
  const tokenRanges = contiguousRanges(tokenBins.map((b) => b.binId));
  let totalTokenAtomic = 0n;
  let totalSolInTokenBinsAtomic = 0n;
  let bothCount = 0;
  for (const b of tokenBins) {
    totalTokenAtomic += b.tokenAtomic;
    totalSolInTokenBinsAtomic += b.solAtomic;
    if (b.kind === "both") bothCount++;
  }
  return {
    classified,
    tokenBins,
    tokenRanges,
    totalTokenAtomic,
    totalSolInTokenBinsAtomic,
    bothCount,
  };
}

/** Clamp reshape re-add width: at least 1, at most 69. */
export function clampReshapeWidth(width: number, fallback: number): number {
  const base = Number.isFinite(width) && width > 0 ? Math.floor(width) : Math.floor(fallback);
  return Math.max(1, Math.min(69, base > 0 ? base : 1));
}

/**
 * Range strictly above active: [active+1, active+width].
 * Returns binsBelow=0 representation for builders that use active±offsets
 * via explicit min/max instead.
 */
export function rangeAboveActive(
  activeBinId: number,
  width: number,
): { minBinId: number; maxBinId: number; binsAbove: number; binsBelow: number } {
  const w = clampReshapeWidth(width, 1);
  return {
    minBinId: activeBinId + 1,
    maxBinId: activeBinId + w,
    binsAbove: w,
    binsBelow: 0,
  };
}

export function atomicToUi(atomic: bigint, decimals: number): number {
  if (decimals <= 0) return Number(atomic);
  const base = 10n ** BigInt(decimals);
  const whole = atomic / base;
  const frac = atomic % base;
  return Number(whole) + Number(frac) / Number(base);
}

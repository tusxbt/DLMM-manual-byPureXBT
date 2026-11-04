/** Lazy-load Meteora DLMM SDK (avoids ESM/CJS issues at import time). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cached: any = null;

export async function getDlmmModule() {
  if (!cached) {
    cached = await import("@meteora-ag/dlmm");
  }
  return cached;
}

export async function getDLMM() {
  const mod = await getDlmmModule();
  return {
    DLMM: mod.default,
    StrategyType: mod.StrategyType as Record<string, number>,
  };
}

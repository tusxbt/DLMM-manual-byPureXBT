/**
 * Strategy registry — tambah strategi baru:
 * 1. Buat file `src/strategies/<nama>.ts` yang export default StrategyDefinition
 * 2. Import & daftarkan di ALL_STRATEGIES di bawah
 * 3. Pastikan meteoraKey cocok dengan StrategyType SDK (Spot | Curve | BidAsk)
 * 4. Dokumentasikan di README
 */
import type { StrategyDefinition, StrategyId } from "./types.js";
import spot from "./spot.js";
import curve from "./curve.js";
import bidAsk from "./bidask.js";
import mix from "./mix.js";

export * from "./types.js";

const ALL_STRATEGIES: StrategyDefinition[] = [spot, curve, bidAsk, mix];

const byId = new Map(ALL_STRATEGIES.map((s) => [s.id, s]));

export function listStrategies(): StrategyDefinition[] {
  return [...ALL_STRATEGIES];
}

export function getStrategy(id: StrategyId): StrategyDefinition | undefined {
  return byId.get(id);
}

export function requireStrategy(id: StrategyId): StrategyDefinition {
  const s = getStrategy(id);
  if (!s) throw new Error(`Unknown strategy: ${id}`);
  return s;
}

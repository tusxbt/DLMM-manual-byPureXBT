import type { StrategyDefinition } from "./types.js";

const bidAsk: StrategyDefinition = {
  id: "bid_ask",
  label: "Bid-Ask",
  description: "Liquidity menumpuk di tepi range (BidAsk) — cocok one-sided SOL di bawah harga.",
  meteoraKey: "BidAsk",
  defaultSide: "one_sided_sol",
  rangePresets: [
    { id: "narrow", label: "Narrow −20%/0%", downPct: 20, upPct: 0 },
    { id: "medium", label: "Medium −40%/0%", downPct: 40, upPct: 0 },
    { id: "wide", label: "Wide −60%/0%", downPct: 60, upPct: 0 },
  ],
};

export default bidAsk;

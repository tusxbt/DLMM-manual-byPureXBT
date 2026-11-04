import type { StrategyDefinition } from "./types.js";

/** Mix: BidAsk for X% of the amount + Spot for the rest, same position & range (ratio in Settings). */
const mix: StrategyDefinition = {
  id: "mix",
  label: "Mix",
  description: "BidAsk + Spot di posisi & range yang sama (default 70/30, atur di Settings).",
  meteoraKey: "BidAsk",
  defaultSide: "one_sided_sol",
  rangePresets: [
    { id: "narrow", label: "Narrow −15%", downPct: 15, upPct: 0 },
    { id: "medium", label: "Medium −30%", downPct: 30, upPct: 0 },
    { id: "wide", label: "Wide −50%", downPct: 50, upPct: 0 },
  ],
};

export default mix;

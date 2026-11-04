import type { StrategyDefinition } from "./types.js";

const spot: StrategyDefinition = {
  id: "spot",
  label: "Spot",
  description: "Liquidity merata di seluruh range (default Meteora Spot).",
  meteoraKey: "Spot",
  defaultSide: "one_sided_sol",
  rangePresets: [
    { id: "narrow", label: "Narrow −15%/+3%", downPct: 15, upPct: 3 },
    { id: "medium", label: "Medium −30%/+5%", downPct: 30, upPct: 5 },
    { id: "wide", label: "Wide −50%/+10%", downPct: 50, upPct: 10 },
  ],
};

export default spot;

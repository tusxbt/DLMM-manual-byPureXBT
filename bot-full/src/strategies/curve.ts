import type { StrategyDefinition } from "./types.js";

const curve: StrategyDefinition = {
  id: "curve",
  label: "Curve",
  description: "Liquidity menumpuk di tengah range (Curve).",
  meteoraKey: "Curve",
  defaultSide: "one_sided_sol",
  rangePresets: [
    { id: "narrow", label: "Narrow −20%/+5%", downPct: 20, upPct: 5 },
    { id: "medium", label: "Medium −35%/+8%", downPct: 35, upPct: 8 },
    { id: "wide", label: "Wide −55%/+12%", downPct: 55, upPct: 12 },
  ],
};

export default curve;

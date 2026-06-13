// The liquidity rung vocabulary now lives on the ladder (ADR 0013). Kept as a
// re-export so the many `./liquidity-tier` importers need no change.
export type { LiquidityTier } from "./liquidity-ladder";

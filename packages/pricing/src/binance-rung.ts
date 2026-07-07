/**
 * The Binance wallet → liquidity rung map (ADR 0016/0021, S3 #248).
 *
 * A Binance fact — which wallets are market-liquid vs term-locked — so it lives
 * with connected-source pricing, not in shared domain code. Kept in a tiny leaf
 * module (only a domain TYPE import) so the sync orchestrator can stamp the rung
 * onto each draft.
 */

import type { LiquidityTier } from "@worthline/domain";

/**
 * The liquidity rung a Binance wallet projects onto. Spot, funding and flexible
 * Earn are all market-liquid (redeemable on demand) → the `market` rung. Locked
 * Earn / locked staking is committed for a fixed term → the `term-locked` rung, a
 * SEPARATE holding. Any wallet outside this table (an unforeseen surface) defaults
 * to `market` — the most conservative liquidity claim, never over-stating how
 * locked a balance is.
 */
export function rungForWallet(wallet: string): LiquidityTier {
  switch (wallet) {
    case "locked-earn":
    case "staking":
      return "term-locked";
    default:
      return "market";
  }
}

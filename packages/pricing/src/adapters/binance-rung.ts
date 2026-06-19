/**
 * The Binance wallet → liquidity rung map (ADR 0016/0021, S3 #248, relocated by
 * #322 out of `@worthline/domain`).
 *
 * A Binance fact — which wallets are market-liquid vs term-locked — so it lives in
 * the Binance adapter's package, not in shared domain code (ADR 0027 §Consequences).
 * Kept in a tiny leaf module (only a domain TYPE import) so both the adapter
 * (`classifyRung`) and the sync orchestrator (`binance-sync.ts`, which stamps the
 * rung onto each draft) can import it without a circular dependency on the adapter.
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

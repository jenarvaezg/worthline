/**
 * Pure view helpers for the Binance crypto holding detail surface (PRD #245,
 * ADR 0021/#247). They turn the source's token positions into the value-sorted
 * rows the detail page renders. The detail GROUPS BY TOKEN (`groupPositionsByToken`),
 * so a token held across wallets (spot · funding · flexible-Earn) shows as ONE row
 * whose value sums every wallet; the wallet origin survives as row metadata. The
 * maths lives here so it is unit-testable without React or a DB.
 *
 * No network, no persistence, no Next.js: maps token positions → view rows. A
 * token whose value resolves with the `zero` basis (every wallet unpriceable) is
 * kept — never silently dropped — and flagged so the row can show the "valor 0" tag.
 */

import { addUnits, groupPositionsByToken } from "@worthline/domain";
import type {
  LiquidityTier,
  SourcePosition,
  TokenPosition,
  TokenValuationBasis,
} from "@worthline/domain";

/**
 * The source's TOKEN positions on ONE liquidity rung — the detail page shows only
 * the positions on the asset's own rung (#248): opening the market asset lists the
 * market tokens, opening the term-locked asset lists the locked ones. Coin
 * positions and tokens on other rungs are excluded. Pure so the page stays thin
 * glue and this filter is unit-testable without a DB.
 */
export function tokenPositionsOnRung(
  positions: readonly SourcePosition[],
  rung: LiquidityTier,
): TokenPosition[] {
  return positions.filter(
    (p): p is TokenPosition => p.kind === "token" && p.liquidityTier === rung,
  );
}

/** A view row for one token (summed across its wallets): identity, total balance,
 *  unit price, live value + basis, and the wallets the balance came from. */
export interface TokenRow {
  id: string;
  symbol: string;
  balance: string;
  unitPrice: string | null;
  valueMinor: number;
  basis: TokenValuationBasis;
  /** The wallets this token's balance spans (origin metadata), in input order. */
  wallets: string[];
}

/** The full view model the surface renders: value-sorted rows + the total. */
export interface BinanceHoldingView {
  totalMinor: number;
  tokenCount: number;
  rows: TokenRow[];
}

/** The es-ES label + CSS class for a token's valuation basis (the row's tag). */
export interface TokenBasisTag {
  label: string;
  cls: string;
}

export function tokenBasisTag(basis: TokenValuationBasis): TokenBasisTag {
  return basis === "zero"
    ? { label: "Valor 0", cls: "coinTagZero" }
    : { label: "Mercado", cls: "coinTagMetal" };
}

/** es-ES labels for the Binance wallets a token's balance can span (#247). */
const WALLET_LABELS: Record<string, string> = {
  spot: "spot",
  funding: "funding",
  "flexible-earn": "Earn flexible",
  "locked-earn": "Earn bloqueado",
};

/**
 * The caption listing the wallets a token's balance came from (#247 metadata),
 * de-duplicated and dot-joined (e.g. "spot · funding"). Empty string when there is
 * nothing to show, so the row can omit the caption.
 */
export function formatWallets(wallets: readonly string[]): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const wallet of wallets) {
    if (seen.has(wallet)) continue;
    seen.add(wallet);
    labels.push(WALLET_LABELS[wallet] ?? wallet);
  }
  return labels.join(" · ");
}

/**
 * Build the holding view by GROUPING the source's positions by token (#247): a
 * token held across wallets folds into one row whose value sums every wallet
 * (`groupPositionsByToken`), whose balance is the summed quantity, and whose
 * `wallets` lists the origin wallets. Rows are value-sorted (the grouping already
 * orders by subtotal desc, symbol asc); `tokenCount` is the number of DISTINCT
 * tokens. A token priced on at least one wallet reads `market`; one unpriceable
 * everywhere reads `zero` (still shown). The total sums every row.
 */
export function buildBinanceHoldingView(
  positions: readonly TokenPosition[],
): BinanceHoldingView {
  const groups = groupPositionsByToken([...positions]);

  const rows: TokenRow[] = groups.map((group) => {
    const balance = group.positions.reduce(
      (sum, position) => addUnits(sum, position.balance),
      "0",
    );
    // The shared unit price for the token (one symbol → one CoinGecko price); the
    // first priced wallet supplies it, null only when every wallet is unpriceable.
    const priced = group.positions.find((position) => position.unitPrice !== null);
    return {
      id: group.symbol,
      symbol: group.symbol,
      balance,
      unitPrice: priced ? priced.unitPrice : null,
      valueMinor: group.subtotalMinor,
      basis: priced ? ("market" as const) : ("zero" as const),
      wallets: group.positions.map((position) => position.wallet),
    };
  });

  const totalMinor = rows.reduce((sum, row) => sum + row.valueMinor, 0);

  return { totalMinor, tokenCount: rows.length, rows };
}

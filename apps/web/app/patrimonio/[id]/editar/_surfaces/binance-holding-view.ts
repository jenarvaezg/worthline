/**
 * Pure view helpers for the Binance crypto holding detail surface (PRD #245,
 * ADR 0021). They turn the source's token positions into the value-sorted rows
 * the detail page renders — the maths (per-token live value via `positionValue`,
 * descending sort, total) lives here so it is unit-testable without React or a DB.
 *
 * No network, no persistence, no Next.js: maps token positions → view rows. A
 * token whose value resolves with the `zero` basis (unmapped/unpriceable) is kept
 * — never silently dropped — and flagged so the row can show the "valor 0" tag.
 */

import { positionValue } from "@worthline/domain";
import type { TokenPosition, TokenValuationBasis } from "@worthline/domain";

/** A view row for one token: identity, balance, unit price, live value + basis. */
export interface TokenRow {
  id: string;
  symbol: string;
  balance: string;
  unitPrice: string | null;
  valueMinor: number;
  basis: TokenValuationBasis;
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

/**
 * Build the holding view from the source's token positions: each row's live value
 * is `balance × unitPrice` (or 0 with the `zero` basis when unpriceable), rows are
 * sorted by value descending (ties keep input order — a stable sort), and the
 * total sums every row. `tokenCount` is the number of token lines (not summed
 * balances — they are heterogeneous quantities).
 */
export function buildBinanceHoldingView(
  positions: readonly TokenPosition[],
): BinanceHoldingView {
  const rows: TokenRow[] = positions.map((position) => {
    const valuation = positionValue(position.balance, position.unitPrice);
    return {
      id: position.id,
      symbol: position.symbol,
      balance: position.balance,
      unitPrice: position.unitPrice,
      valueMinor: valuation.minor,
      basis: valuation.basis,
    };
  });

  rows.sort((a, b) => b.valueMinor - a.valueMinor);

  const totalMinor = rows.reduce((sum, row) => sum + row.valueMinor, 0);

  return { totalMinor, tokenCount: rows.length, rows };
}

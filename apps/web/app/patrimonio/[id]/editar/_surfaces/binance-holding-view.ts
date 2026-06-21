/**
 * Pure view helpers for the Binance crypto holding detail surface (PRD #245,
 * ADR 0021/#247). They turn the source's token positions into the value-sorted
 * rows the detail page renders. The detail GROUPS BY TOKEN (`groupPositionsByToken`),
 * so a token held across wallets (spot · funding · flexible-Earn) shows as ONE row
 * whose value sums every wallet; the wallet origin survives as row metadata. The
 * maths lives here so it is unit-testable without React or a DB.
 *
 * No network, no persistence, no Next.js: maps token positions → view rows. Dust —
 * a token whose value rounds to 0,00 € (junk under a cent, incl. one unpriceable on
 * every wallet) — is hidden by default (#479). DISPLAY-ONLY: the position stays in
 * storage/snapshots/reconciliation, only its row and the count are suppressed.
 */

import { addUnits, groupPositionsByToken, isTokenDustValue } from "@worthline/domain";
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
  /** The token's logo URL (resolved at sync, #482); null → glyph fallback. */
  imageUrl: string | null;
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
 * non-dust tokens. Dust rows — value rounds to 0,00 €, incl. tokens unpriceable on
 * every wallet — are filtered out by default (#479, display-only); `tokenCount` and
 * `totalMinor` reflect the kept rows (the total is unchanged, dust being worth 0).
 */
export function buildBinanceHoldingView(
  positions: readonly TokenPosition[],
): BinanceHoldingView {
  const groups = groupPositionsByToken([...positions]);

  const rows: TokenRow[] = groups
    .filter((group) => !isTokenDustValue(group.subtotalMinor))
    .map((group) => {
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
        // All wallets of a symbol share its logo; take the first non-null (#482).
        imageUrl: group.positions.find((p) => p.imageUrl)?.imageUrl ?? null,
        wallets: group.positions.map((position) => position.wallet),
      };
    });

  const totalMinor = rows.reduce((sum, row) => sum + row.valueMinor, 0);

  return { totalMinor, tokenCount: rows.length, rows };
}

/**
 * The "Datos desde DD/MM/YYYY" label for the curve start (PRD #245 S5, #250): the
 * earliest snapshot dateKey carrying this holding's frozen row — how far back the
 * reconstructed monthly history reaches. Renders an es-ES `DD/MM/YYYY` date from
 * the YYYY-MM-DD key (parsed as UTC so the day never shifts across a timezone).
 * Null when there is no curve start (no backfilled history yet). Pure — no React,
 * no DB — so the page stays thin glue.
 */
export function formatBinanceSince(dateKey: string | null): string | null {
  if (dateKey === null) return null;
  const label = new Date(`${dateKey}T00:00:00Z`).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Datos desde ${label}`;
}

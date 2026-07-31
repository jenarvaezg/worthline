/**
 * The es-ES display name of a price source — the ONE place a provider key turns
 * into prose (#1329). Four surfaces kept their own copy of this switch (the
 * investment editor's rejection message, the wizard's symbol search, the
 * advanced-alta table, the chat alta's quote provenance), so a fifth caller was
 * the moment to make it shared.
 *
 * Keyed on the domain union rather than `string`, so adding a source breaks the
 * build here instead of silently printing its raw key at the user.
 */

import type { PriceSource } from "@worthline/domain";

const LABELS: Record<PriceSource, string> = {
  binance: "Binance",
  coingecko: "CoinGecko",
  ecb: "BCE",
  finect: "Finect",
  manual: "Manual",
  numista: "Numista",
  stooq: "Stooq",
  yahoo: "Yahoo Finance",
};

export function priceSourceLabel(source: PriceSource): string {
  return LABELS[source];
}

/**
 * The label for a provider that no longer fetches (#1354), for the one place a
 * retired provider is still offered: the edit form of a holding that already
 * carries it. Lives here so the "(retirado)" suffix is prose in the prose module,
 * not a string spliced into JSX.
 */
export function retiredPriceSourceLabel(source: PriceSource): string {
  return `${LABELS[source]} (retirado)`;
}

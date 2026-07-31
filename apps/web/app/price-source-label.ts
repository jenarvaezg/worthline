/**
 * The es-ES display name of a price source — the ONE place a provider key turns
 * into prose (#1329). Four surfaces kept their own copy of this switch (the
 * investment editor's rejection message, the wizard's symbol search, the
 * advanced-alta table, the chat alta's quote provenance), so a fifth caller was
 * the moment to make it shared. The key itself is the fallback: an unknown
 * source prints honestly rather than as an empty label.
 */

const LABELS: Record<string, string> = {
  coingecko: "CoinGecko",
  ecb: "BCE",
  finect: "Finect",
  stooq: "Stooq",
  yahoo: "Yahoo Finance",
};

export function priceSourceLabel(source: string): string {
  return LABELS[source] ?? source;
}

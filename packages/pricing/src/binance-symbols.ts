/**
 * Binance symbol → CoinGecko id resolver (ADR 0021).
 *
 * Binance reports balances by exchange ticker (`BTC`), but CoinGecko's price API
 * keys by coin id (`bitcoin`). This is the seam that bridges the two so a Binance
 * BTC and a hand-entered crypto investment priced from CoinGecko show the SAME
 * unit price (the consistency goal of ADR 0021). It deliberately covers the
 * common, high-cap tokens only: an unmapped symbol resolves to `null`, and the
 * caller values that position 0 with the existing "value at 0" warning — never
 * silently dropped, never fabricated. The map can grow without touching callers.
 */

/** Common Binance tickers → CoinGecko ids. Keys are upper-case (Binance's form). */
const COINGECKO_ID_BY_SYMBOL: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  USDC: "usd-coin",
  BNB: "binancecoin",
  SOL: "solana",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  DOT: "polkadot",
  TRX: "tron",
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  LINK: "chainlink",
  AVAX: "avalanche-2",
  ATOM: "cosmos",
  XLM: "stellar",
  UNI: "uniswap",
  ETC: "ethereum-classic",
  NEAR: "near",
  ARB: "arbitrum",
  OP: "optimism",
  FIL: "filecoin",
  APT: "aptos",
  DAI: "dai",
  SHIB: "shiba-inu",
  PEPE: "pepe",
  WBETH: "wrapped-beacon-eth",
  BETH: "binance-eth",
};

/**
 * Whether a Binance balance symbol is fiat EUR cash (not the EURS stablecoin).
 * EUR cash is valued at flat 1:1 parity with EUR — it has no CoinGecko id
 * (issue #730).
 */
export function isBinanceFiatEur(symbol: string): boolean {
  return symbol.trim().toUpperCase() === "EUR";
}

/**
 * The CoinGecko id for a Binance symbol, or null when it is not in the map (the
 * caller then values the position 0 and raises the "value at 0" warning). Case-
 * and whitespace-insensitive — Binance reports upper-case tickers, but we
 * normalize so a lower-case or padded symbol still resolves.
 */
export function resolveCoinGeckoId(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  const direct = COINGECKO_ID_BY_SYMBOL[normalized];
  if (direct !== undefined) return direct;

  if (normalized.startsWith("LD")) {
    return COINGECKO_ID_BY_SYMBOL[normalized.slice(2)] ?? null;
  }

  return null;
}

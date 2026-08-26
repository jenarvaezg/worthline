import { MARKET_SYMBOL_SEARCH_SCHEMA } from "@web/asistente/chat-tools/schemas/reads";
import { resolveMarketSymbolCandidates } from "@web/asistente/market-symbol-search";
import { type ToolSet, tool } from "ai";

/**
 * Resolving a market instrument's price symbol (PRD #921). Read-only and outside
 * the store: it queries the price providers directly, so it is the one family that
 * takes no turn state — and says so by taking no argument.
 */
export function marketSymbolReadTools(): ToolSet {
  return {
    search_market_symbol: tool({
      description:
        "Resuelve el `providerSymbol` (ticker de precios) de un instrumento de mercado por nombre o ISIN; buscar por ISIN además IDENTIFICA, porque el candidato vuelve con ese ISIN junto a su símbolo. " +
        "Devuelve candidatos (symbol, name, isin, market, currency) para desambiguar — el sufijo de mercado importa: VUSA.L ≠ VUSA.AS —. " +
        "`instrument` enruta el proveedor: fund/etf/stock/index → Yahoo, crypto → CoinGecko (el symbol es el id de la moneda, p. ej. `bitcoin`). " +
        "Pasa el `symbol` elegido a propose_holding.providerSymbol. Si no hay ningún candidato fiable, crea el alta igualmente (avisará de que el precio no se actualizará). Solo lectura.",
      inputSchema: MARKET_SYMBOL_SEARCH_SCHEMA,
      execute: async (args) => {
        const matches = await resolveMarketSymbolCandidates(
          args.query ?? "",
          args.instrument,
        );
        return { matches };
      },
    }),
  };
}

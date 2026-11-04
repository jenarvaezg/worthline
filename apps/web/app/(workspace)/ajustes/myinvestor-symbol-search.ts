/**
 * The price symbol of an ISIN or DGS code at worthline's providers (#1880): the
 * first candidate of a provider worthline prices with, or null — a product nobody
 * quotes is valued at cost until someone gives it a symbol.
 *
 * «Nobody quotes it» and «the search failed» both answer null, because both leave
 * the product at cost and neither may stop the batch. Only the failure is logged
 * on the server (#1876), with the instrument and the error, never the code. A
 * provider that answers an HTTP error is already read as «no results» inside
 * `searchSymbols`, which never throws on purpose (the search box degrades by
 * provider); what reaches the log here is what got past that.
 */
import { searchSymbols } from "@worthline/pricing";
import {
  isInvestmentPriceProvider,
  type MyInvestorSymbolResolver,
} from "./myinvestor-first-start-flow";

type SymbolSearch = (
  code: string,
  instrument: Parameters<MyInvestorSymbolResolver>[1],
) => Promise<readonly { provider: string; symbol: string }[]>;

type ServerLog = (message: string, detail: Record<string, unknown>) => void;

export function myInvestorSymbolResolver(
  search: SymbolSearch = searchSymbols,
  log: ServerLog = console.error,
): MyInvestorSymbolResolver {
  return async (code, instrument) => {
    try {
      const [hit] = await search(code, instrument);
      return hit && isInvestmentPriceProvider(hit.provider)
        ? { provider: hit.provider, symbol: hit.symbol }
        : null;
    } catch (error) {
      log("[myinvestor] symbol search failed", {
        error: error instanceof Error ? error.message : String(error),
        instrument,
      });
      return null;
    }
  };
}

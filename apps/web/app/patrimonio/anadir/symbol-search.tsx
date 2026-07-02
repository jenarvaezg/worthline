import type { Instrument } from "@worthline/domain";
import { searchSymbols } from "@worthline/pricing";
import Link from "next/link";

import { buildSymbolSearchCurrentParams } from "./search-state";

/**
 * Symbol search for the investment forms — no client JS, matching the app's
 * server-rendered form ethos. A GET sub-form posts the query back to the same
 * page (`?symbolq=`); the server runs the search and renders candidates, each
 * a link that prefills the main form via `pf*` params (consumed as defaults).
 *
 * Sits as a SIBLING of the main investment form (forms cannot nest): picking a
 * candidate is a plain navigation that re-renders the page with the fields
 * filled, leaving the user free to adjust before submitting.
 */
export default async function SymbolSearch({
  basePath,
  query,
  pickedSymbol,
  currentParams,
  instrument,
}: {
  basePath: string;
  query?: string | undefined;
  pickedSymbol?: string | undefined;
  currentParams: Record<string, string | string[] | undefined>;
  instrument?: Instrument | undefined;
}) {
  const trimmed = query?.trim() ?? "";
  const candidates = trimmed ? await searchSymbols(trimmed, instrument) : [];
  const preservedParams = buildSymbolSearchCurrentParams(currentParams);

  function prefillHref(
    symbol: string,
    name: string,
    provider: string,
    isin?: string,
  ): string {
    const params = new URLSearchParams();
    // Copy current params to preserve selected instrument and typed values
    for (const [key, value] of Object.entries(preservedParams)) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          value.forEach((v) => params.append(key, v));
        } else {
          params.set(key, value);
        }
      }
    }
    params.set("symbolq", trimmed);
    params.set("pfName", name);
    params.set("pfSymbol", symbol);
    params.set("pfProvider", provider);
    if (isin) params.set("pfIsin", isin);
    return `${basePath}?${params.toString()}`;
  }

  return (
    <div className="symbolSearch">
      <div className="symbolSearchForm">
        <label>
          Buscar símbolo <small>(nombre, ISIN, o slug de Finect)</small>
          <span className="symbolSearchRow">
            <input
              aria-label="Buscar símbolo por nombre o ISIN"
              defaultValue={trimmed}
              name="symbolq"
              placeholder="IE00BYX5NX33, MSCI World, N5394-Myinvestor…"
              type="search"
            />
            <button formAction={basePath} formMethod="get">
              Buscar
            </button>
          </span>
        </label>
      </div>

      {trimmed ? (
        candidates.length > 0 ? (
          <ul className="symbolSearchResults" aria-label="Resultados de búsqueda">
            {candidates.map((c) => {
              const isPicked = pickedSymbol === c.symbol;
              return (
                <li key={`${c.provider}:${c.symbol}`}>
                  <Link
                    className={`symbolResult${isPicked ? " symbolResultPicked" : ""}`}
                    href={prefillHref(c.symbol, c.name, c.provider, c.isin)}
                  >
                    <span className="symbolResultSymbol">{c.symbol}</span>
                    <span className="symbolResultName">{c.name}</span>
                    <span className="symbolResultMeta">
                      {[providerLabel(c.provider), c.quoteType, c.exchange, c.currency]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="emptyLine">
            Sin resultados para “{trimmed}”. Revisa el nombre/ISIN o rellena el símbolo
            del proveedor a mano.
          </p>
        )
      ) : null}
    </div>
  );
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "yahoo":
      return "Yahoo Finance";
    case "stooq":
      return "Stooq";
    case "finect":
      return "Finect";
    case "coingecko":
      return "CoinGecko";
    default:
      return provider;
  }
}

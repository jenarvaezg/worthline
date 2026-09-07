import type { Instrument } from "@worthline/domain";
import { searchSymbols } from "@worthline/pricing";

import { buildSymbolSearchCurrentParams } from "./search-state";
import { SymbolCandidateRow } from "./symbol-candidate-row";
import { symbolPrefillHref } from "./symbol-prefill";

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
            {candidates.map((candidate) => (
              <SymbolCandidateRow
                candidate={candidate}
                href={symbolPrefillHref({
                  basePath,
                  candidate,
                  preservedParams,
                  query: trimmed,
                })}
                key={`${candidate.provider}:${candidate.symbol}`}
                picked={pickedSymbol === candidate.symbol}
              />
            ))}
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

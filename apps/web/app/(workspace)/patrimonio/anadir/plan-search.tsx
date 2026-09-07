/**
 * «El código siembra la búsqueda» — variante A de #1669, la conducta que ganó el
 * prototipo.
 *
 * Un plan de pensiones no tiene ISIN: se identifica por su código DGS, y su símbolo
 * de precio es un slug de Finect que nadie tiene impreso en ningún papel. Así que el
 * alta simple del plan pide UNA cosa —el código— y el servidor resuelve el símbolo
 * por la API pública de Finect (ADR 0011, #1357). Elegir el candidato es una
 * navegación que prellena nombre y símbolo; el símbolo no existe como campo visible
 * aquí, viaja prellenado.
 *
 * Lo que este componente NO hace es bloquear. Finect caído, lento o un código que no
 * existe se resuelven a «sin candidato», y entonces lo que se lee es la salida:
 * guardar igual. «Identificado, sin cotizar» es un estado legítimo (invariante 6 del
 * PRD #1741) que recoge salud de datos, con reintento desde la ficha.
 *
 * Presentacional: el candidato lo resuelve la página (como el precio en vivo), que es
 * quien puede pagar la llamada de red una sola vez.
 */

import { priceSourceLabel } from "@web/price-source-label";
import type { SymbolCandidate } from "@worthline/pricing";
import Link from "next/link";
import type { AddHoldingSearchParams } from "./search-state";
import { symbolPrefillHref } from "./symbol-prefill";

/** What the plan search resolved for the code the user typed. */
export interface PlanSearchState {
  /** The code as it travelled — what the user typed, not yet normalized. */
  code: string;
  candidate: SymbolCandidate | null;
}

export function PlanSearchResult({
  basePath,
  currentParams,
  pickedSymbol,
  state,
}: {
  basePath: string;
  currentParams: AddHoldingSearchParams;
  /** The candidate already picked, so the row reads as chosen after the navigation. */
  pickedSymbol?: string | undefined;
  state: PlanSearchState;
}) {
  if (!state.candidate) {
    return (
      <p className="emptyLine">
        No hemos podido identificar «{state.code}» en Finect ahora mismo. Revisa el código
        de tu extracto —el del plan empieza por N— o <strong>guárdalo igual</strong>: el
        plan queda identificado por su código y sin cotizar, y desde su ficha puedes
        reintentar la búsqueda del símbolo.
      </p>
    );
  }

  const candidate = state.candidate;
  const isPicked = pickedSymbol === candidate.symbol;

  return (
    <ul className="symbolSearchResults" aria-label="Plan encontrado">
      <li>
        <Link
          className={`symbolResult${isPicked ? " symbolResultPicked" : ""}`}
          href={symbolPrefillHref({
            basePath,
            candidate,
            preservedParams: currentParams,
          })}
        >
          <span className="symbolResultSymbol">{candidate.symbol}</span>
          <span className="symbolResultName">{candidate.name}</span>
          <span className="symbolResultMeta">
            {[
              priceSourceLabel(candidate.provider),
              candidate.quoteType,
              candidate.currency,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </Link>
      </li>
    </ul>
  );
}

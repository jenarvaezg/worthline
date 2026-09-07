/**
 * One search candidate, as the alta draws it (#1746).
 *
 * Both searches print the same row — the symbol box's list and the plan's single
 * hit — and the row is not just three spans: it is the vocabulary of what a
 * candidate SHOWS (its symbol, its name, and the provider/type/exchange/currency
 * line) plus the «this one is picked» mark. Two copies drifted the moment one of
 * them started showing the currency and the other the exchange.
 */

import { priceSourceLabel } from "@web/price-source-label";
import type { SymbolCandidate } from "@worthline/pricing";
import Link from "next/link";

export function SymbolCandidateRow({
  candidate,
  href,
  picked,
}: {
  candidate: SymbolCandidate;
  /** Where picking it navigates — built by `symbolPrefillHref`. */
  href: string;
  picked: boolean;
}) {
  return (
    <li>
      <Link className={`symbolResult${picked ? " symbolResultPicked" : ""}`} href={href}>
        <span className="symbolResultSymbol">{candidate.symbol}</span>
        <span className="symbolResultName">{candidate.name}</span>
        <span className="symbolResultMeta">
          {[
            priceSourceLabel(candidate.provider),
            candidate.quoteType,
            candidate.exchange,
            candidate.currency,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </Link>
    </li>
  );
}

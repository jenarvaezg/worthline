import {
  type AttachmentExtractionResult,
  capExtractionWarnings,
  isIsoDay,
  parseExtractionResult,
} from "./attachment-extraction-contract";

/**
 * Separating what a dated balance series OBSERVED from what it FORECASTS (#1424).
 *
 * A cuadro de amortización is half history and half prediction, and it prints nothing
 * that tells the halves apart: the extractor read 49 balances off Jorge's schedule and
 * the last four are dated 2027, 2032 and 2034 — the bank's projection of what the loan
 * will be worth if nothing changes. The contract has always said only *observed*
 * balances are read, and it had no way to keep that promise, because the fact that
 * separates them is not in the document at all. It is the date of the turn.
 *
 * So the mark is stamped HERE, once, over the validated reading of BOTH lanes (the
 * deterministic sheet route and the vision seam), and never asked of a model: a model
 * that decides which of its own rows already happened is inventing exactly what ADR
 * 0048 forbids, while `date > today` is arithmetic.
 *
 * What the mark is FOR, precisely, because it is easy to overstate:
 *
 * - the preview card paints those rows as a forecast rather than as a reading;
 * - the model receives them marked inside the structured block, so it can stop
 *   proposing them (and stop reasoning from a 2034 balance as if it were a fact);
 * - the reading says out loud how many rows are on the far side of the line.
 *
 * What it does NOT do is guard the curve. `planBalanceHistoryImport` already excludes
 * a future-dated row from the reconstruction and always has, so nothing here changes
 * which points govern a debt. This closes the half that was open: the user was being
 * shown a bank's forecast labelled «saldos fechados leídos del documento», and had to
 * explain in prose, in a chat, that his own July 2027 instalment depends on a euríbor
 * that does not exist yet.
 *
 * Pure and synchronous: no clock of its own — the turn's date is passed in, because
 * demo targets run on a pinned one (`chatAsOf`) and a `new Date()` here would put the
 * assistant's reading a decade away from the dashboard it is talking about.
 */

/** How a reading says which of its rows are the document's forecast. */
export function projectedBalancesWarning(
  projected: number,
  total: number,
  today: string,
): string {
  const verb = projected === 1 ? "es" : "son";
  return (
    `${projected} de los ${total} saldos ${verb} posteriores a hoy (${today}): ` +
    "son la previsión del documento, no saldos observados, y no entran en la reconstrucción."
  );
}

/**
 * Stamp `projected` on every balance dated after `today`, and say how many there were.
 *
 * Returns the input UNCHANGED — the same reference — for everything that is not a
 * valid `balance_series` with at least one future row, so a caller can hand it every
 * reading without branching. The one case that costs anything is the one that needs it.
 *
 * A `today` that is not a real calendar day disables the mark rather than guessing:
 * a lexicographic comparison against garbage would mark every row or none, and both
 * are lies. The reading then means what a pre-#1424 card meant — nothing known about
 * which rows already happened — which is the honest degradation.
 */
export function markProjectedBalances(
  result: AttachmentExtractionResult,
  today: string,
): AttachmentExtractionResult {
  if (result.status !== "valid" || result.data.documentType !== "balance_series") {
    return result;
  }
  if (!isIsoDay(today)) return result;

  const { balances } = result.data;
  const projected = balances.filter((balance) => balance.date > today).length;
  if (projected === 0) return result;

  const marked = parseExtractionResult({
    data: {
      ...result.data,
      balances: balances.map((balance) =>
        balance.date > today ? { ...balance, projected: true } : balance,
      ),
      // First, like every other disclosure about the reading AS A WHOLE: what the
      // contract's warning cap drops must not be «which of these rows are real».
      warnings: capExtractionWarnings([
        projectedBalancesWarning(projected, balances.length, today),
        ...result.data.warnings,
      ]),
    },
    status: "valid",
  });
  // Unreachable by construction — the widened row shape and the capped warnings are
  // both inside the contract — but a re-parse that failed would turn a good reading
  // into `invalid_output`, which is strictly worse than a reading without the mark:
  // only `unrecognized` and `valid` keep the document in the conversation at all.
  return marked.status === "valid" ? marked : result;
}

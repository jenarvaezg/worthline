import type { InvestmentOperation } from "./investment-types";
import type { CurrencyCode } from "./money";
import { signedInvestedMinor } from "./operation-flow";

/**
 * A suggested monthly savings capacity derived from real investment operations
 * (PRD #421, #425). It is a *default* the user can override in the FIRE config —
 * never a hard figure — so it is deliberately simple: net new money invested,
 * averaged over the calendar months the operations span.
 */
export interface MonthlySavingsSuggestion {
  /** Suggested monthly savings in minor units. Never negative — see `basis`. */
  amountMinor: number;
  /** Calendar months spanned by the operations used (≥ 1; 0 when there are none). */
  monthsCovered: number;
  /** `operations` when derived from history; `insufficient_data` when there is none. */
  basis: "operations" | "insufficient_data";
}

/**
 * The **measured monthly savings** (#1449): the same net-money-invested reading
 * as the suggestion above, but over a trailing window and **with its sign**.
 *
 * It exists because the suggestion cannot answer the two questions the coherence
 * watch asks. A suggestion floors at 0 (a negative *capacity* is nonsense) — and
 * "you are dis-saving" is precisely the fact that vetoes an achievement badge. A
 * suggestion also averages over the span *between* operations, which reads a
 * single buy from six months ago as a monthly habit; a watch has to divide by the
 * months that actually elapsed. Same money rule (`netInvestedMinor`), different
 * question — never a second implementation of what savings are.
 */
export interface MonthlySavingsMeasurement {
  /** Measured monthly savings in minor units. **Signed**: negative = dis-saving. */
  amountMinor: number;
  /** Net money invested across the whole window (minor units, signed). */
  netMinor: number;
  /**
   * Months the average divides by: the window, clipped to how long the ledger has
   * existed inside it. A two-month-old ledger divides by 2, not by 12.
   */
  monthsCovered: number;
  /** Operations that fell inside the window and were counted. */
  operationsCount: number;
  /** In-window operations left out because they are denominated elsewhere (#1401). */
  skippedForeignCount: number;
  /** `insufficient_data` only when the ledger is empty — see `monthsCovered`. */
  basis: "operations" | "insufficient_data";
  /** First month of the window (`YYYY-MM`), so a consumer can name what it measured. */
  windowStartMonthKey: string;
  /** Last month of the window (`YYYY-MM`) — the month of `asOfDateKey`. */
  windowEndMonthKey: string;
}

export interface MeasureMonthlySavingsOptions {
  /** The day the measurement is taken; its calendar month closes the window. */
  asOfDateKey: string;
  /** Trailing window length in calendar months, inclusive of `asOfDateKey`'s. Default 12. */
  windowMonths?: number;
  /**
   * When set, only operations in this currency are counted and the rest are
   * reported in `skippedForeignCount`. Omit to sum every operation as given —
   * the currency-agnostic behaviour the form's suggestion has always had.
   */
  currency?: CurrencyCode;
}

/** Months since year 0, so a difference is a calendar-month count. */
function monthIndex(isoDate: string): number {
  const [year, month] = isoDate.split("-");
  return Number(year) * 12 + (Number(month) - 1);
}

/** `YYYY-MM` for a month index — the inverse of `monthIndex`. */
function monthKey(index: number): string {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/**
 * The money one operation moved into (+) or out of (−) savings: a `buy` is cost
 * out of pocket (units × price + fees), a `sell` is money pulled back out
 * (units × price − fees). The single definition of "savings" in this module —
 * both the suggestion and the measurement read it (#1449).
 *
 * A traspaso is worth ZERO here, both halves (#1393). Savings is money that came
 * from outside; a traspaso only changes which product holds money that was already
 * invested. Counting the incoming half as a buy would be the failure of #1449 all
 * over again — this figure is measured PER HOLDING as well as per workspace, so a
 * fund that received 50.000 € would report a savings capacity nobody earned, and
 * the FIRE projection would ride it.
 *
 * An **apertura** is worth ZERO for the same reason (#1490): `source: "opening"` is
 * the mark of a position the user is DECLARING, not one he bought that month. Jorge's
 * 27 uds of the SXR1 — bought between December and January, typed into the app on 19
 * August — landed as a 5.865,75 € buy dated that day and read as 5.865,75 € saved in
 * August. Pre-existing wealth entering the book is not new money, whatever date the
 * alta stamps it with; the coherence watch and the FIRE projection cannot be fed a
 * contribution nobody made.
 *
 * The zero is on the MONEY, not on the operation: the row still dates the ledger
 * (`monthsCovered`) and still counts as a witness that it is awake — exactly as a
 * traspaso leg does. Dropping it would make a ledger that opens with an apertura read
 * as younger than it is, and #1449 needs three months before it trusts anything.
 */
function netInvestedMinor(operation: InvestmentOperation): number {
  if (operation.source === "opening") return 0;
  return signedInvestedMinor(operation, "zero");
}

/**
 * Suggest a monthly savings capacity from a holding's (or the workspace's)
 * investment operations.
 *
 * Savings = money you directed into investments (`netInvestedMinor`). The net
 * across the whole history, divided by the number of calendar months it spans, is
 * the average you actually saved per month. A net-negative history (you withdrew
 * more than you invested) floors at 0 — you are dis-saving, and a negative
 * *capacity* would be nonsense. When that matters, ask
 * `measureMonthlySavings` instead: it keeps the sign.
 *
 * Currency-agnostic by design: it sums minor amounts as given, so the caller is
 * responsible for passing operations in (or already converted to) one currency.
 * Worthline investment operations are overwhelmingly single-currency, and the
 * result is a soft, user-overridable default — not a reconciled figure.
 */
export function suggestMonthlySavingsCapacity(
  operations: InvestmentOperation[],
): MonthlySavingsSuggestion {
  if (operations.length === 0) {
    return { amountMinor: 0, monthsCovered: 0, basis: "insufficient_data" };
  }

  let netMinor = 0;
  let firstMonth = Infinity;
  let lastMonth = -Infinity;

  for (const operation of operations) {
    netMinor += netInvestedMinor(operation);

    const month = monthIndex(operation.executedAt);
    firstMonth = Math.min(firstMonth, month);
    lastMonth = Math.max(lastMonth, month);
  }

  const monthsCovered = lastMonth - firstMonth + 1;
  const amountMinor = Math.max(0, Math.round(netMinor / monthsCovered));

  return { amountMinor, monthsCovered, basis: "operations" };
}

/**
 * Measure the monthly savings a ledger actually shows over a trailing window
 * (#1449) — the one figure the app can produce without anyone typing it.
 *
 * The window closes on `asOfDateKey`'s calendar month and spans `windowMonths`
 * months back. The average divides by those months **clipped to how long the
 * ledger has existed**: a two-month-old ledger divides by 2, so a beginner is
 * not read as saving a sixth of what he saves. A ledger that predates the window
 * but shows no operations inside it measures **0 saved**, not "no data" — an
 * honest reading of a year without a single contribution. Only a ledger with no
 * operations at all is `insufficient_data`.
 */
export function measureMonthlySavings(
  operations: readonly InvestmentOperation[],
  options: MeasureMonthlySavingsOptions,
): MonthlySavingsMeasurement {
  const windowMonths = Math.max(1, options.windowMonths ?? 12);
  const endMonth = monthIndex(options.asOfDateKey);
  const startMonth = endMonth - (windowMonths - 1);
  const window = {
    windowEndMonthKey: monthKey(endMonth),
    windowStartMonthKey: monthKey(startMonth),
  };

  let netMinor = 0;
  let operationsCount = 0;
  let skippedForeignCount = 0;
  let ledgerFirstMonth = Infinity;
  let ledgerHasOperations = false;

  for (const operation of operations) {
    const month = monthIndex(operation.executedAt);
    const inWindow = month >= startMonth && month <= endMonth;
    const isForeign =
      options.currency !== undefined && operation.currency !== options.currency;

    if (isForeign) {
      // A foreign-currency operation is not evidence of anything here: summing
      // dollars as euros is the very bug #1401 fixed. It is counted, not summed,
      // so a consumer can tell "measured 0" from "cannot measure".
      if (inWindow) {
        skippedForeignCount += 1;
      }
      continue;
    }

    ledgerHasOperations = true;
    ledgerFirstMonth = Math.min(ledgerFirstMonth, month);

    if (!inWindow) {
      continue;
    }

    netMinor += netInvestedMinor(operation);
    operationsCount += 1;
  }

  if (!ledgerHasOperations) {
    return {
      amountMinor: 0,
      basis: "insufficient_data",
      monthsCovered: 0,
      netMinor: 0,
      operationsCount: 0,
      skippedForeignCount,
      ...window,
    };
  }

  const monthsCovered = Math.max(
    1,
    Math.min(windowMonths, endMonth - ledgerFirstMonth + 1),
  );

  return {
    amountMinor: Math.round(netMinor / monthsCovered),
    basis: "operations",
    monthsCovered,
    netMinor,
    operationsCount,
    skippedForeignCount,
    ...window,
  };
}

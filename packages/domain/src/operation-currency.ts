import type { DecimalString } from "./decimal";
import { scaleDecimal } from "./decimal";
import type { DomainResult } from "./domain-result";
import { BASE_CURRENCY, createMoneyConverter, type FxRateSnapshot } from "./fx";
import type {
  CreateInvestmentOperationInput,
  InvestmentOperation,
  OperationCapture,
} from "./investment-types";
import type { CurrencyCode } from "./money";
import { money } from "./money";

/**
 * Currency at the operation seam (#1401).
 *
 * The valuation converts; the LEDGER did not. Every capture path stamped
 * `currency: "EUR"` without asking, so eight MyInvestor purchases of a USD-denominated
 * Fidelity fund landed as `0.255 @ 8.00 EUR` when 8,00 was dollars — a cost basis 17,7 %
 * too high, and invisible, because the market value was right and only the return
 * cojeaba. Nobody suspects the return.
 *
 * Two exports, the two halves of the fix:
 *
 * - {@link convertOperationToBaseCurrency} — the ONE door a non-EUR apunte goes
 *   through before it is persisted. It converts with the rate DATED to the execution
 *   day (never today's), and keeps the original apunte so the conversion can be
 *   audited instead of re-derived.
 * - {@link mixedCurrencyWarning} — the guard that used to be a comment. `derivePosition`
 *   folds every operation into ONE accumulator and labels it with the asset's currency;
 *   that is only sound because every operation is in that currency, an invariant
 *   nothing verified.
 *
 * Pure: the ECB fetch is an adapter (`resolveFxRateSnapshot` in `@worthline/pricing`),
 * so this module takes a snapshot of observations and no network dependency — the same
 * posture as {@link createMoneyConverter}, whose money leg it reuses rather than
 * re-implementing a second rounding rule for fees.
 */

/**
 * Decimals a converted unit price is cut at. Eight, matching what every provider
 * quote is already rounded to (`PRICE_SCALE` in `@worthline/pricing`) — so a
 * converted price is no more precise than a fetched one, and the two are comparable.
 *
 * The cut moves the cost: cost is `units × price` rounded to the cent, so an 8-dp
 * price is off by at most `units × 5e-9` euros — a hundredth of a cent on a million
 * units. That is well under the cent the fold rounds to anyway, unlike the 20-dp
 * `divideUnits` default whose precision the app cannot even read back (#1395).
 */
export const CONVERTED_PRICE_DECIMALS = 8;

/**
 * Re-express a captured operation in EUR at the rate of its execution date, or refuse
 * it when no rate covers that date.
 *
 * A EUR apunte passes through byte for byte and carries no {@link OperationCapture} —
 * which also makes this idempotent: its own output is EUR, so converting twice is the
 * same as converting once, and a retry can never double-convert a cost basis.
 *
 * Refusal is data, not an exception: ECB publishes business days only, and
 * `FxRateSnapshot` already carries the previous business day forward within
 * {@link FX_CARRY_FORWARD_DAYS} (the exact policy the manual repair of the father's
 * eight operations used). Past that window there is no honest EUR figure, and the
 * capture is rejected rather than stored at an invented rate — the #1065 posture
 * applied one layer earlier.
 */
export function convertOperationToBaseCurrency(
  input: CreateInvestmentOperationInput,
  rates: FxRateSnapshot,
): DomainResult<CreateInvestmentOperationInput> {
  const converted = convertCapturedFigures(
    {
      currency: input.currency,
      dateKey: input.executedAt,
      feesMinor: input.feesMinor ?? 0,
      pricePerUnit: input.pricePerUnit,
    },
    rates,
  );

  if (!converted.ok) {
    return converted;
  }

  if (converted.value.capture === undefined) {
    return { ok: true, value: input };
  }

  return {
    ok: true,
    value: {
      ...input,
      capture: converted.value.capture,
      currency: BASE_CURRENCY,
      feesMinor: converted.value.feesMinor,
      pricePerUnit: converted.value.pricePerUnit,
    },
  };
}

/** A price + fees stated in some currency on some day — the unit of conversion. */
export interface CapturedFigures {
  currency: CurrencyCode;
  /** The day the rate is dated to (`YYYY-MM-DD`, or a timestamp it is sliced from). */
  dateKey: string;
  pricePerUnit: DecimalString;
  feesMinor: number;
}

/** The euro figures, plus the capture that records what they came from. */
export interface ConvertedFigures {
  pricePerUnit: DecimalString;
  feesMinor: number;
  /** Absent when the input was already euros — nothing was converted. */
  capture?: OperationCapture;
}

/**
 * The conversion itself, on the two figures that carry money: the unit price (a decimal
 * string, scaled through the decimal seam) and the fees (integer minor units, routed
 * through {@link createMoneyConverter} so there is ONE rounding rule for money).
 *
 * Its own export because two shapes need it and neither should own it: an operation
 * about to be persisted, and a statement row about to become one. Sharing this is what
 * keeps a re-imported file from converting differently than a hand-typed apunte.
 */
export function convertCapturedFigures(
  figures: CapturedFigures,
  rates: FxRateSnapshot,
): DomainResult<ConvertedFigures> {
  if (figures.currency === BASE_CURRENCY) {
    return {
      ok: true,
      value: { feesMinor: figures.feesMinor, pricePerUnit: figures.pricePerUnit },
    };
  }

  const eurPerUnit = rates.eurPerUnit(figures.currency, figures.dateKey);
  const convertedFees = createMoneyConverter(rates).convert(
    money(figures.feesMinor, figures.currency),
    BASE_CURRENCY,
    figures.dateKey,
  );

  if (eurPerUnit === null || !convertedFees.ok) {
    return {
      ok: false,
      violations: [
        {
          code: "operation_currency_missing_rate",
          currency: figures.currency,
          executedAt: figures.dateKey,
        },
      ],
    };
  }

  return {
    ok: true,
    value: {
      capture: {
        currency: figures.currency,
        eurPerUnit,
        feesMinor: figures.feesMinor,
        pricePerUnit: figures.pricePerUnit,
      },
      feesMinor: convertedFees.value.amountMinor,
      pricePerUnit: scaleDecimal(
        figures.pricePerUnit,
        eurPerUnit,
        CONVERTED_PRICE_DECIMALS,
      ),
    },
  };
}

/**
 * The Spanish warning for a ledger whose operations are not all in `folded` — the
 * currency `derivePosition` labels the summed cost with — or null when they are.
 *
 * It fires on a ledger written ENTIRELY in another currency too, which is exactly the
 * shape #1401 was: eight USD operations summed and labelled EUR. Checking only for
 * disagreement BETWEEN operations would have stayed silent on the very case that
 * cost 17,7 % of a cost basis.
 *
 * A warning, not a failure: the fold's arithmetic is unchanged, so an existing
 * portfolio keeps rendering — it just stops being silent about a figure that cannot
 * be trusted. Writes are the layer that prevents the state
 * ({@link convertOperationToBaseCurrency}); this is the layer that admits it when it
 * happened anyway, through a path that predates the conversion.
 */
export function mixedCurrencyWarning(
  operations: readonly InvestmentOperation[],
  folded: CurrencyCode,
): string | null {
  const present = new Set<CurrencyCode>();
  for (const operation of operations) {
    present.add(operation.currency);
  }

  if (present.size === 0 || (present.size === 1 && present.has(folded))) {
    return null;
  }

  const listed = [...present].sort();
  const [only] = listed;

  if (listed.length === 1 && only !== undefined) {
    return `Las operaciones de esta inversión están en ${only}, pero el coste se ha sumado como si fueran ${folded}.`;
  }

  return `Las operaciones de esta inversión están en varias divisas (${listed.join(", ")}); el coste se ha sumado como si todas fueran ${folded}.`;
}

/**
 * The currencies an apunte may be captured in — a CLOSED vocabulary, and every entry
 * a two-decimal currency.
 *
 * Two decimals is not decoration: the whole money model scales by ×100 (`fx.ts`
 * documents the assumption), so offering JPY or KWD would mean offering a capture the
 * fee arithmetic silently mangles. What is here is what ECB publishes daily AND what
 * a European fund or broker realistically states an order in; widening it is one line
 * plus a decimals decision, which is exactly the review it deserves.
 */
export const CAPTURE_CURRENCIES: readonly CurrencyCode[] = [
  BASE_CURRENCY,
  "USD",
  "GBP",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "CAD",
  "AUD",
];

/** True when `currency` is one this app can honestly capture an apunte in. */
export function isCaptureCurrency(currency: string): boolean {
  return CAPTURE_CURRENCIES.includes(currency);
}

/**
 * The currency this holding's apuntes are last known to have been captured in, or
 * undefined when nothing says.
 *
 * It reads `capture`, NOT `currency`: since #1401 every stored operation is in EUR, so
 * `currency` would answer "EUR" for the very USD fund the question is about. A user
 * who bought the same dollar fund eight times should type the currency once, and the
 * ledger is the only place that remembers which one it was.
 *
 * `ledger` is expected in canonical order (`compareInvestmentOperations` — which is
 * how the store hands operations out), so the answer is simply the last captured one.
 * Taking that as a precondition instead of re-sorting keeps this module off
 * `positions.ts`, whose `derivePosition` already depends on this one. The cost of a
 * caller getting it wrong is bounded: this only pre-fills a form field the user sees
 * and can change.
 */
export function lastCapturedCurrency(
  ledger: readonly InvestmentOperation[],
): CurrencyCode | undefined {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const capture = ledger[index]?.capture;
    if (capture !== undefined) {
      return capture.currency;
    }
  }

  return undefined;
}

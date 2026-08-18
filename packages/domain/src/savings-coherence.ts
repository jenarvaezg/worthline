import type { FireScopeConfig } from "./fire";
import { monthlySavingsCapacityForFire } from "./fire-savings-capacity";
import type { InvestmentOperation } from "./investment-types";
import { type CurrencyCode, formatMoneyMinorPrivacy } from "./money";
import { type MonthlySavingsMeasurement, measureMonthlySavings } from "./monthly-savings";

/**
 * Declared-vs-measured savings coherence (#1449) — the counterweight to #1416.
 *
 * With the plan→FIRE derivation cut (ADR 0074), the declared scalar rules the
 * projection and nothing corrects it. But of the three figures describing the
 * same monthly flow — spending, income, savings — **savings is the only one the
 * app can measure on its own**, from the operations ledger. Crossing the measured
 * figure against the declared one is what turns that scalar from "a number
 * nobody ever checked" into a number with a witness.
 *
 * This module only *states the disagreement*. It never decides which side is
 * wrong: a 1.400 €/month gap can be an optimistic declaration, a ledger the user
 * keeps outside the app, or savings that never reach an investment at all. All
 * three are worth surfacing; none is worth guessing between.
 */

/** Trailing window the measured savings are read over. */
export const MEASURED_SAVINGS_WINDOW_MONTHS = 12;

/**
 * Months of ledger required before the measurement is treated as evidence. Two
 * months is a payday and a holiday, not a habit — and this figure both raises an
 * alert and vetoes a badge, so it has to be worth trusting.
 */
export const MEASURED_SAVINGS_MIN_MONTHS = 3;

/**
 * Both thresholds must be crossed for a gap to be news: 100 €/month in absolute
 * terms, and a quarter of the larger of the two figures. The absolute floor keeps
 * rounding and a skipped month quiet; the ratio keeps a 100 € wobble on a
 * 2.000 €/month declaration quiet too. Jorge's real case (1.500 declared against
 * ~120 measured) clears both by an order of magnitude.
 */
export const SAVINGS_DIVERGENCE_MIN_ABSOLUTE_MINOR = 10_000;
export const SAVINGS_DIVERGENCE_MIN_RATIO = 0.25;

export type SavingsCoherenceState =
  /** Not enough ledger to say anything — no alert, and no veto either. */
  | "insufficient_data"
  /** Declared and measured agree within the thresholds. */
  | "aligned"
  /** They cannot both be true. Which one is wrong is not this module's call. */
  | "diverged";

export interface SavingsCoherence {
  state: SavingsCoherenceState;
  /** The declared capacity the FIRE projection runs on, via `monthlySavingsCapacityForFire`. */
  declaredMinor: number;
  /** The measured monthly savings (signed) — negative means dis-saving. */
  measuredMinor: number;
  /** `declaredMinor − measuredMinor`: positive = declaring more than the ledger shows. */
  gapMinor: number;
  /** The full measurement, so a consumer can name the window it read. */
  measured: MonthlySavingsMeasurement;
  /**
   * True when the ledger is trustworthy evidence AND it goes down: the real
   * trajectory is away from FIRE, so no "alcanzado" badge may claim otherwise.
   */
  vetoesAchievement: boolean;
}

export interface AssessSavingsCoherenceInput {
  /** The scope's FIRE config; the declared figure is read through its one reader. */
  config: FireScopeConfig;
  /** The scope's investment operations — the whole ledger, windowing happens here. */
  operations: readonly InvestmentOperation[];
  /** Base currency: operations denominated elsewhere are evidence of nothing (#1401). */
  currency: CurrencyCode;
  /** The day the assessment is taken (`YYYY-MM-DD`). */
  asOfDateKey: string;
}

export function assessSavingsCoherence(
  input: AssessSavingsCoherenceInput,
): SavingsCoherence {
  const measured = measureMonthlySavings(input.operations, {
    asOfDateKey: input.asOfDateKey,
    currency: input.currency,
    windowMonths: MEASURED_SAVINGS_WINDOW_MONTHS,
  });

  const declaredMinor = monthlySavingsCapacityForFire(input.config);
  const measuredMinor = measured.amountMinor;
  const gapMinor = declaredMinor - measuredMinor;

  // A window that mixes currencies is not a measurement: part of the money is
  // missing from it, so a gap could be the conversion rather than the habit.
  const isEvidence =
    measured.basis === "operations" &&
    measured.monthsCovered >= MEASURED_SAVINGS_MIN_MONTHS &&
    measured.skippedForeignCount === 0;

  if (!isEvidence) {
    return {
      declaredMinor,
      gapMinor,
      measured,
      measuredMinor,
      state: "insufficient_data",
      vetoesAchievement: false,
    };
  }

  const magnitude = Math.max(Math.abs(declaredMinor), Math.abs(measuredMinor));
  const diverged =
    Math.abs(gapMinor) >= SAVINGS_DIVERGENCE_MIN_ABSOLUTE_MINOR &&
    Math.abs(gapMinor) >= SAVINGS_DIVERGENCE_MIN_RATIO * magnitude;

  return {
    declaredMinor,
    gapMinor,
    measured,
    measuredMinor,
    state: diverged ? "diverged" : "aligned",
    vetoesAchievement: measuredMinor < 0,
  };
}

export interface ScopeSavingsCoherenceInput {
  config: FireScopeConfig;
  currency: CurrencyCode;
  /** The workspace ledger keyed by holding id. */
  operationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  /** The holdings the scope owns (`scopeOwnedHoldingIds`). */
  ownedHoldingIds: ReadonlySet<string>;
  asOfDateKey: string;
}

/**
 * The scope-level reading: the same assessment over the operations of the
 * holdings a scope owns. The one place that decides which ledger answers for a
 * scope, so the health alert (#654) and the badge veto on screen cannot end up
 * measuring different sets of holdings.
 *
 * Ownership shares are NOT prorated: a holding half-owned by the scope
 * contributes its whole ledger. This is a coherence watch, not a book figure —
 * and the declared capacity it is compared against is a single household-level
 * scalar with no share to speak of either.
 */
export function scopeSavingsCoherence(
  input: ScopeSavingsCoherenceInput,
): SavingsCoherence {
  const operations: InvestmentOperation[] = [];
  for (const [holdingId, holdingOperations] of input.operationsByAssetId) {
    if (input.ownedHoldingIds.has(holdingId)) {
      operations.push(...holdingOperations);
    }
  }

  return assessSavingsCoherence({
    asOfDateKey: input.asOfDateKey,
    config: input.config,
    currency: input.currency,
    operations,
  });
}

/**
 * The one sentence that states a divergence (#1449) — the health-engine alert and
 * the FIRE panel both render it, so the wording cannot drift between the place
 * that raises the doubt and the place that shows the figures it puts in doubt.
 *
 * It shows all three numbers and assigns no blame: an optimistic declaration, a
 * stale spending figure, rents declared gross, and savings that never reach an
 * investment all look like this, and only the user knows which.
 */
export function describeSavingsDivergence(
  coherence: SavingsCoherence,
  currency: CurrencyCode,
  privacyMode = false,
): string {
  const amount = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
  const months = coherence.measured.monthsCovered;
  const window = `${months} ${months === 1 ? "mes" : "meses"}`;
  const measured =
    coherence.measuredMinor < 0
      ? `${amount(coherence.measuredMinor)} (te descapitalizas)`
      : amount(coherence.measuredMinor);

  return (
    `Declaras ahorrar ${amount(coherence.declaredMinor)} al mes y tus operaciones ` +
    `de los últimos ${window} miden ${measured}: ` +
    `${amount(Math.abs(coherence.gapMinor))} de diferencia. Las dos no pueden ser ` +
    `verdad a la vez — revisa tu gasto, tus rentas o la capacidad declarada.`
  );
}

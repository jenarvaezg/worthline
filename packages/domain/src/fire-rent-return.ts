/**
 * The rent-derived real return (#1448): for a property whose income is
 * **declared**, the FIRE rate comes from that income instead of the housing
 * rung's guessed 3 %.
 *
 * The tier defaults (`TIER_REAL_RETURN_DEFAULTS`) are what the app assumes when it
 * knows nothing about an asset. For a rented flat it knows something: a
 * **payout schedule** says what the flat pays and how often (ADR 0054). Jorge's
 * four flats carry 23.500 €/año of declared rent on 370.000 € of brick, and the
 * housing default was pricing them at 3 % — the cheap guess landing on the 68 %
 * of the pool that decides his whole expected return.
 *
 * Two rules make the substitution honest, and both are load-bearing:
 *
 * 1. **Net or nothing.** A landlord does not live on the gross: the agency, the
 *    rent-default insurance, the IBI, the community fees, the home insurance,
 *    maintenance and the empty months all eat first. Jorge's GROSS rent over value
 *    is 6,3 % — it overstates by as much as the 3 % understates, and in the
 *    dangerous direction. So a schedule with no declared expenses derives NOTHING:
 *    the tier default stays and the asset is reported as a notice ("declare your
 *    expenses and this rent will count"), never silently promoted to its gross.
 * 2. **Only the housing rung.** Rent is inflation-linked, so a net rental yield
 *    already is a REAL yield, and a flat's real appreciation on top of it is ~0 by
 *    construction — which is what makes "net rent / value" a real total return. A
 *    deposit's interest is nominal (2 % interest under 2 % inflation is 0 % real)
 *    and a fund's dividend is a fraction of its total return, not the whole of it.
 *    Substituting a declared yield there would be a category error, so a
 *    non-property asset with declared payouts keeps its tier rate, silently.
 *
 * The rate is share-invariant on purpose: rent and value are both declared for
 * 100 % of the property, so a 50 %-owned flat yields the same percentage — only
 * the WEIGHT it carries in the pool is scoped (`assembleFireEligiblePool`).
 *
 * Pure: ISO dates in, decimals out. No DB, no clock.
 */

import { isHousingAsset } from "./classification";
import type { CurrencyCode } from "./money";
import type { PayoutCadence, PayoutSchedule } from "./payouts";
import type { ManualAsset } from "./workspace-types";

/** Occurrences per year for each cadence. Weekly is 52 — an approximation, named. */
const OCCURRENCES_PER_YEAR: Record<PayoutCadence, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

/** Annualize one occurrence's minor amount at its cadence. */
export function annualizedMinor(amountMinor: number, cadence: PayoutCadence): number {
  return amountMinor * OCCURRENCES_PER_YEAR[cadence];
}

/**
 * Whether a schedule is in force on `todayISO` — started, and not ended. A rent
 * that stops next month still pays today, and one that stopped last month is not
 * income any more: Navalcarnero and Casarrubios expire on 2026-09-01 and
 * 2026-10-01, so the rate has to look at the window, not just at the row.
 */
export function isScheduleLiveOn(
  schedule: Pick<PayoutSchedule, "startISO" | "endISO">,
  todayISO: string,
): boolean {
  if (schedule.startISO > todayISO) {
    return false;
  }
  return schedule.endISO === null || schedule.endISO === undefined
    ? true
    : schedule.endISO >= todayISO;
}

/** Why a declared rent did NOT become a rate. Each one is shown, never swallowed. */
export type RentReturnNoticeReason =
  /** Some live schedule has no `expensesMinor`: the gross would flatter, so nothing is used. */
  | "missing_expenses"
  /**
   * No schedule on the asset is in force today — every one of them has ended, or
   * has not started yet. The two are merged deliberately (the answer is the same:
   * no income today), so the copy has to speak both: "not in force today", never
   * "it expired".
   */
  | "no_live_schedule"
  /** The property is valued in a currency the payout amounts do not declare (#1401). */
  | "foreign_currency"
  /**
   * The rate WAS derived, and then the scope's own declaration took its rung out of
   * FIRE (#1460): the user said the immobilized capital does not count, so neither
   * does its yield. Nothing is missing and nothing is wrong — which is why the copy
   * for this one must not ask the user to fix anything.
   */
  | "immobilized_not_counted";

/** A property whose declared net rent replaced its tier's rate. */
export interface RentDerivedReturn {
  assetId: string;
  assetName: string;
  /** Annual real return as a decimal: `annualNetRentMinor / valueMinor`. May be negative. */
  rate: number;
  /** Annualized declared rent across the asset's live schedules (100 % of the property). */
  annualGrossRentMinor: number;
  /** Annualized declared expenses across the same schedules. */
  annualExpensesMinor: number;
  /** `annualGrossRentMinor − annualExpensesMinor`. Negative when the costs exceed the rent. */
  annualNetRentMinor: number;
  /** The property's declared value (100 %), the denominator of `rate`. */
  valueMinor: number;
  /** The live schedules that fed it, so the UI can name what it read. */
  scheduleIds: string[];
  /**
   * True when declared expenses exceed the rent. Declarable and real (a flat can
   * cost more than it earns), so it is applied — but it is never applied quietly:
   * a negative yield that looks like an arithmetic slip has to be nameable.
   */
  isNetNegative: boolean;
}

/** A declared rent that stayed out of the rate, with the reason and what was skipped. */
export interface RentReturnNotice {
  assetId: string;
  assetName: string;
  reason: RentReturnNoticeReason;
  /**
   * The GROSS rate that was not used (decimal), when there is a live schedule to
   * compute it from — the figure the copy needs to say what is being withheld and
   * why. Null when no live schedule exists or the value is unusable.
   */
  grossRate: number | null;
}

/**
 * What the FIRE result reports about rent-derived rates for ONE scope: the rates
 * that took effect, and the declarations that did not with their reason. Both are
 * already filtered to what the scope owns and FIRE counts
 * (`assembleFireEligiblePool`) — a screen can render them as they come.
 */
export interface AppliedRentReturn extends RentDerivedReturn {
  /**
   * What the SCOPE owns of the property (minor units) — the weight the rate carries
   * in the pool. Every other figure on this entry is declared for 100 % of the
   * property, so a screen that prints them next to a scoped total has to say which
   * is which: on a 50 %-owned flat the two differ by half.
   */
  scopedValueMinor: number;
}

export interface FireRentReturnReport {
  /** The properties whose declared net rent replaced their tier rate for this scope. */
  applied: AppliedRentReturn[];
  /** Declared rents that did not feed the rate, and why. */
  notices: RentReturnNotice[];
  /**
   * The scope's annual NET rent (minor units), already scaled to what it owns — the
   * income half of the sustainable-spending answer (#1428, ADR 0081).
   *
   * It counts every rent this scope's eligible properties DERIVED a rate from, and it
   * is deliberately independent of the immobilized declaration (#1460): a flat the
   * user will never sell is not FIRE capital, and its rent is still money arriving
   * every month. The two halves cannot double-count each other, because the capital
   * half only ever reads the *sellable* side and a rented property lives on the
   * immobilized one.
   *
   * Net or nothing, like the rate it came from (ADR 0076): a schedule with no declared
   * expenses contributes 0 here and stays a notice — the gross would flatter a figure
   * somebody may plan their retirement on.
   */
  netRentAnnualMinor: number;
}

export interface RentRealReturns {
  /** Asset id → its derived return. The pool applies these over the tier defaults. */
  byAssetId: ReadonlyMap<string, RentDerivedReturn>;
  /** Declared rents that did not feed a rate. Ordered as the assets came in. */
  notices: RentReturnNotice[];
}

export interface DeriveRentRealReturnsInput {
  /**
   * The candidate assets. Pass them ALL: eligibility and scope ownership are decided
   * once, downstream, by `assembleFireEligiblePool` — pre-filtering here would make
   * which notices survive depend on the caller.
   */
  assets: readonly ManualAsset[];
  /** Every declared payout schedule; the ones off these assets are picked here. */
  schedules: readonly PayoutSchedule[];
  /** Today (YYYY-MM-DD) — the date schedule validity is measured against. */
  todayISO: string;
  /** The workspace's base currency: payout amounts carry no currency of their own. */
  baseCurrency: CurrencyCode;
}

/**
 * The scope's annual NET rent (minor units) — the income half of the
 * sustainable-spending answer (#1428, ADR 0081), assembled where the rent arithmetic
 * lives instead of inside the FIRE result literal.
 *
 * `overrides` are the per-asset rates the pool kept for this scope: eligible, owned,
 * and net-declared. Their `amountMinor` IS the scoped value the rate was weighted
 * with, so scaling each property's declared net rent by `amountMinor / valueMinor`
 * gives the scope's share through exactly the same proportion — one reading of
 * ownership, not two.
 *
 * Pass every override the pool derived, INCLUDING the rungs the immobilized
 * declaration took out of the capital (#1460): that declaration is about capital, and
 * a flat nobody plans to sell still pays its rent every month.
 */
export function scopedNetRentAnnualMinor(
  overrides: readonly { assetId: string; amountMinor: number }[],
  rentRealReturns: RentRealReturns,
): number {
  let total = 0;
  for (const override of overrides) {
    const derived = rentRealReturns.byAssetId.get(override.assetId);
    if (derived === undefined || derived.valueMinor <= 0) {
      continue;
    }
    total += Math.round(
      (derived.annualNetRentMinor * override.amountMinor) / derived.valueMinor,
    );
  }
  return total;
}

/**
 * Derive a real return per property from its declared net rent. See the module
 * doc for the two rules; everything not derived comes back as a notice, except
 * the two silent cases documented inline (a non-property asset, and a property
 * with no value to divide by).
 */
export function deriveRentRealReturns(
  input: DeriveRentRealReturnsInput,
): RentRealReturns {
  const { assets, schedules, todayISO, baseCurrency } = input;

  const schedulesByHolding = new Map<string, PayoutSchedule[]>();
  for (const schedule of schedules) {
    const rows = schedulesByHolding.get(schedule.holdingId);
    if (rows) {
      rows.push(schedule);
    } else {
      schedulesByHolding.set(schedule.holdingId, [schedule]);
    }
  }

  const byAssetId = new Map<string, RentDerivedReturn>();
  const notices: RentReturnNotice[] = [];

  for (const asset of assets) {
    const declared = schedulesByHolding.get(asset.id);
    if (declared === undefined || declared.length === 0) {
      continue;
    }
    // Rule 2: only the housing rung. A fund's declared dividend is a fraction of
    // its total return and a deposit's interest is nominal — neither is the whole
    // real return the way a net rental yield is. Silent: nothing is being withheld
    // from the user, the tier rate is simply the right answer there.
    if (!isHousingAsset(asset)) {
      continue;
    }

    const valueMinor = asset.currentValue.amountMinor;
    const live = declared.filter((schedule) => isScheduleLiveOn(schedule, todayISO));

    const annualGrossRentMinor = live.reduce(
      (total, schedule) =>
        total + annualizedMinor(schedule.amountMinor, schedule.cadence),
      0,
    );
    // The gross rate exists only to explain what is NOT being used; a property with
    // no value to divide by cannot produce one.
    const grossRate = valueMinor > 0 ? annualGrossRentMinor / valueMinor : null;

    if (live.length === 0) {
      notices.push({
        assetId: asset.id,
        assetName: asset.name,
        grossRate: null,
        reason: "no_live_schedule",
      });
      continue;
    }

    // A payout amount carries no currency: it is the workspace's base. A property
    // valued in another one would divide dollars by euros — #1401's failure, and
    // one that flatters or punishes by whatever the pair happens to be worth.
    if (asset.currentValue.currency !== baseCurrency) {
      notices.push({
        assetId: asset.id,
        assetName: asset.name,
        grossRate: null,
        reason: "foreign_currency",
      });
      continue;
    }

    // Rule 1: net or nothing, and it is all-or-nothing per asset. Netting only the
    // schedules that happen to declare expenses would understate the costs — the
    // optimistic direction, which is the one this issue exists to close.
    if (live.some((schedule) => schedule.expensesMinor == null)) {
      notices.push({
        assetId: asset.id,
        assetName: asset.name,
        grossRate,
        reason: "missing_expenses",
      });
      continue;
    }

    // A property with no value carries no weight in the pool either, so there is
    // nothing to warn about: skipping it silently is the honest answer.
    if (valueMinor <= 0) {
      continue;
    }

    const annualExpensesMinor = live.reduce(
      (total, schedule) =>
        total + annualizedMinor(schedule.expensesMinor ?? 0, schedule.cadence),
      0,
    );
    const annualNetRentMinor = annualGrossRentMinor - annualExpensesMinor;

    byAssetId.set(asset.id, {
      annualExpensesMinor,
      annualGrossRentMinor,
      annualNetRentMinor,
      assetId: asset.id,
      assetName: asset.name,
      isNetNegative: annualNetRentMinor < 0,
      rate: annualNetRentMinor / valueMinor,
      scheduleIds: live.map((schedule) => schedule.id),
      valueMinor,
    });
  }

  return { byAssetId, notices };
}

import type { WeightedDestination } from "./decimal";
import { splitMinorByWeights } from "./decimal";
import type { AssetClassResolution, ExposureCoverage } from "./exposure-lookthrough";
import { breakdownDestinations, OTHER_BUCKET_KEY } from "./exposure-lookthrough";
import type { InvestmentOperation } from "./investment-types";
import type { CurrencyCode, MoneyMinor } from "./money";
import { money } from "./money";
import type {
  DatedPayout,
  IrrResult,
  MonthlyCloseValue,
  SimpleGain,
  TwrResult,
} from "./returns";
import type { SubsetReturnsSlice } from "./returns-subset";
import { subsetReturns } from "./returns-subset";

/**
 * Per-asset-class investment returns (#552, ADR 0040 fast-follow, gated on #539
 * S0). Groups holdings by their resolved exposure-profile **asset class** and
 * reports each class's simple gain / IRR / TWR — reusing the S0/S1 return engines
 * over each class bucket, and the same asset-class resolution the exposure
 * look-through uses (`resolveAssetClassBreakdown`), so grouping stays consistent
 * with the exposure surface.
 *
 * Attribution is **fractional and present-time**, mirroring the look-through: a
 * 60/40 fund contributes 60% of its cashflows, market value and monthly closes to
 * `equity` and 40% to `bond`. A breakdown that declares under 100% sends the
 * remainder to `other` (as the look-through does); a holding with no resolvable
 * class falls whole into `unclassified` — honest coverage, never a fabricated
 * class (#539's coverage model). Because the class weight is a present-time lens
 * (never frozen), it is applied uniformly across a holding's history — the same
 * approximation the look-through makes, declared not hidden.
 *
 * Pure: it takes pre-resolved class weights and an injected valuation date, so it
 * is deterministic and delegates every figure to the proven pure engines.
 *
 * Value allocation is the look-through's OWN split, not a parallel one: the class
 * destinations come from `breakdownDestinations` and the céntimos from
 * `splitMinorByWeights`, the same two functions `lookThroughExposure` calls
 * (#1610). So a class `value` reconciles with the matching `exposure.assetClass`
 * slice to the céntimo, not merely at display granularity — «¿cuánto de este
 * holding es renta variable?» has one answer, and the surface that asks it does
 * not change it. What the weight still cannot do is travel back in time: it is a
 * present-time lens applied uniformly across the history, declared above.
 */

/** The bucket that collects holdings whose asset class cannot be resolved. */
export const UNCLASSIFIED_ASSET_CLASS_KEY = "unclassified";
/**
 * The bucket that collects the declared-under-100% remainder of a breakdown —
 * the look-through's own remainder key, aliased rather than respelled so the two
 * surfaces cannot drift into naming the same money differently.
 */
export const OTHER_ASSET_CLASS_KEY = OTHER_BUCKET_KEY;

/** One holding's return inputs plus its resolved asset-class breakdown. */
export interface AssetClassReturnsHolding {
  operations: readonly InvestmentOperation[];
  /** Current market value in minor units (0 when fully sold or unpriced). */
  marketValueMinor: number;
  /**
   * This holding's monthly-close value series (for TWR); empty when unavailable.
   * Must be on the SAME basis as `marketValueMinor` (both gross, or both scoped).
   */
  monthlyCloses: readonly MonthlyCloseValue[];
  /** The resolved asset-class weights, from `resolveAssetClassBreakdown`. */
  assetClass: AssetClassResolution;
  /**
   * The owner's share in basis points (default 10000 = whole holding), applied to
   * the operation cashflows BEFORE the class weight. `marketValueMinor` and
   * `monthlyCloses` must ALREADY be on the caller's chosen basis: pass the scoped
   * `ownedMinor` value + `ownershipBps` for an ownership-scoped decomposition (the
   * agent view, matching the portfolio block), or the full value + omit
   * `ownershipBps` for a gross one (the dashboard). Keeping the three inputs on one
   * basis is what makes each class's simple gain / IRR internally consistent.
   */
  ownershipBps?: number;
  /**
   * Recorded distributions (dividends/coupons/rent, #657), scaled by ownership
   * then class weight exactly like the operation cashflows, so a class's simple
   * gain / IRR stays coherent with the portfolio measures.
   */
  payouts?: readonly DatedPayout[];
}

/** One asset class's blended returns over the fractional slice of every holding. */
export interface AssetClassReturns {
  /** `equity` | `bond` | … | `other` | `unclassified`. */
  key: string;
  /** Present-time market value attributed to the class. */
  value: MoneyMinor;
  simpleGain: SimpleGain;
  irr: IrrResult;
  twr: TwrResult;
  /** Whether any recorded payout was folded into this class (#657) — per-class so a
   *  payout-free class never claims income it did not receive. */
  payoutsIncluded: boolean;
  /**
   * Whether the class has no value attributed today: it is here because it once
   * held something, not because it holds it now (#1456). The class is still
   * emitted with all its measures — the domain MARKS, it never omits, so no
   * consumer loses a figure it could want — but a reader that ranks classes by
   * their weight in today's portfolio can fold it away. Same reasoning as a
   * closed position (`isClosedPosition`, #1348) one level up: a value that
   * multiplies nothing cannot compromise today's split.
   */
  closed: boolean;
}

export interface ReturnsByAssetClassInput {
  holdings: readonly AssetClassReturnsHolding[];
  currency: CurrencyCode;
  valuationDate: string;
}

export interface ReturnsByAssetClass {
  /**
   * One entry per class present, sorted by attributed value desc, then key — so
   * the classes marked `closed` (zero value today, #1456) sit last.
   */
  classes: AssetClassReturns[];
  /** Three-way coverage of attributed value (asset class has no not-applicable). */
  coverage: ExposureCoverage;
}

/** A whole holding: the weight `unclassified` takes when no class resolves. */
const WHOLE_WEIGHT = "1";

/**
 * The buckets a holding's value and ledger are split across, with the exact
 * weight of each.
 *
 * A classified breakdown reads through `breakdownDestinations` — the
 * look-through's own reading, `other` remainder included — so neither surface can
 * invent a bucket the other does not have, nor weigh a shared one differently. An
 * unresolvable class sends the whole holding to `unclassified`, the honest
 * coverage gap the look-through routes to `coverage.unknown` rather than to a
 * slice.
 */
function classDestinations(resolution: AssetClassResolution): WeightedDestination[] {
  return resolution.kind === "unknown"
    ? [{ key: UNCLASSIFIED_ASSET_CLASS_KEY, weight: WHOLE_WEIGHT }]
    : breakdownDestinations(resolution.breakdown);
}

export function returnsByAssetClass(
  input: ReturnsByAssetClassInput,
): ReturnsByAssetClass {
  // One bucket per class, each a list of SLICES of the contributing holdings: the
  // aggregation itself — the double scaling, the same-day netting, the monthly
  // alignment — belongs to `subsetReturns`, which the cartera gestionada rides too
  // (#1552). A class and a cartera are the same question about a different subset.
  const buckets = new Map<string, SubsetReturnsSlice[]>();

  for (const holding of input.holdings) {
    const destinations = classDestinations(holding.assetClass);
    // ONE pass over the holding's whole value, not one rounding per bucket: the
    // céntimos the largest remainder awards each class here are the céntimos the
    // look-through awards the same class over the same value (#1610). Rounding
    // bucket by bucket is how the two surfaces used to land a céntimo apart on a
    // weight that does not fall on exact céntimos.
    const attributed = new Map(
      splitMinorByWeights(holding.marketValueMinor, destinations),
    );

    for (const { key, weight } of destinations) {
      const slices = buckets.get(key);
      const slice: SubsetReturnsSlice = {
        marketValueMinor: attributed.get(key) ?? 0,
        monthlyCloses: holding.monthlyCloses,
        operations: holding.operations,
        share: weight,
        ...(holding.ownershipBps === undefined
          ? {}
          : { ownershipBps: holding.ownershipBps }),
        ...(holding.payouts === undefined ? {} : { payouts: holding.payouts }),
      };
      if (slices) {
        slices.push(slice);
      } else {
        buckets.set(key, [slice]);
      }
    }
  }

  const classes: AssetClassReturns[] = [...buckets.entries()]
    .map(([key, slices]) => {
      const returns = subsetReturns({
        currency: input.currency,
        slices,
        valuationDate: input.valuationDate,
      });
      return {
        // Callers feed this engine operation-bearing holdings only, so a zero
        // attributed value means the class was left (sold, transferred away) and
        // not that nothing was ever bought. A market value is never negative — the
        // `<=` is defensive, and treats an impossible negative the same way: a
        // class in that state sustains nothing either.
        closed: returns.marketValueMinor <= 0,
        irr: returns.irr,
        key,
        payoutsIncluded: returns.payoutsIncluded,
        simpleGain: returns.simpleGain,
        twr: returns.twr,
        value: money(returns.marketValueMinor, input.currency),
      };
    })
    .sort(
      (left, right) =>
        right.value.amountMinor - left.value.amountMinor ||
        left.key.localeCompare(right.key),
    );

  return { classes, coverage: coverageFrom(classes, input.currency) };
}

function coverageFrom(
  classes: readonly AssetClassReturns[],
  currency: CurrencyCode,
): ExposureCoverage {
  let unknownMinor = 0;
  let classifiedMinor = 0;
  for (const entry of classes) {
    if (entry.key === UNCLASSIFIED_ASSET_CLASS_KEY) {
      unknownMinor += entry.value.amountMinor;
    } else {
      classifiedMinor += entry.value.amountMinor;
    }
  }

  return {
    classified: money(classifiedMinor, currency),
    notApplicable: money(0, currency),
    unknown: money(unknownMinor, currency),
  };
}

import type { ReferenceDataUnavailableReason } from "@worthline/domain";

import type { AgentViewMoney } from "./shared";

/** A holding/instrument/rung allocation slice with its weight of gross assets. */
export interface AgentViewAllocationSlice {
  key: string;
  value: AgentViewMoney;
  /** Slice value over gross assets, as a `0..1` decimal string. */
  weight: string;
}

/** A top holding in the exposure summary. */
export interface AgentViewExposureHolding {
  id: string;
  object: "holding";
  label: string;
  value: AgentViewMoney;
  weight: string;
}

/**
 * How completely a look-through dimension covers the scope's gross assets, as a
 * three-way split of money (PRD #539, ADR 0039, ADR 0084): `classified` has
 * declared bucket data, `notApplicable` means the dimension is meaningless for
 * that money (cash, crypto, a declared `sin_region`/`sin_divisa` sleeve), and
 * `unknown` means the dimension applies but that fraction has no declared
 * bucket. Keeping `notApplicable` distinct stops crypto/cash — and gold inside a
 * mixed fund — from reading as missing data. Only `unknown` is a gap to fill.
 * The slices never pretend to cover 100%; the coverage is how the agent reports
 * "X% classified, Y% still unknown".
 */
export interface AgentViewExposureCoverage {
  classified: AgentViewMoney;
  notApplicable: AgentViewMoney;
  unknown: AgentViewMoney;
  /**
   * Set only when the global exposure catalog could not be read (PRD #711 S3,
   * ADR 0058): the look-through / per-class returns could not classify against
   * reference data, so this coverage reflects "catalog unavailable", NOT
   * "profiles missing". Absent in the normal case where the catalog was read.
   * MCP/chat inherit this signal without re-deriving it.
   */
  catalogUnavailable?: ReferenceDataUnavailableReason;
}

/**
 * One look-through dimension (geography / currency / asset class): the allocation
 * slices (same `AgentViewAllocationSlice` shape as `byInstrument`) plus the
 * three-way coverage they were computed against (PRD #539, ADR 0039).
 */
export interface AgentViewExposureDimension {
  slices: AgentViewAllocationSlice[];
  coverage: AgentViewExposureCoverage;
}

/** Where the scope's money sits and how concentrated it is. */
export interface AgentViewExposure {
  topHoldings: AgentViewExposureHolding[];
  byLiquidityTier: AgentViewAllocationSlice[];
  byInstrument: AgentViewAllocationSlice[];
  /**
   * Present-time look-through by underlying geography (PRD #539, ADR 0039): the
   * portfolio's real region exposure, aggregated from exposure profiles by the
   * S0 domain function — never a figure and never frozen into a snapshot.
   */
  byGeography: AgentViewExposureDimension;
  /** Present-time look-through by underlying currency (PRD #539, ADR 0039). */
  byCurrency: AgentViewExposureDimension;
  /** Present-time look-through by asset class (PRD #539, ADR 0039). */
  byAssetClass: AgentViewExposureDimension;
  /**
   * Present-time look-through by GICS-11 sector, equity-scaled (PRD #1018, ADR
   * 0065). Unlike the whole-fund geography/currency dimensions (whose
   * undeclared remainder is `unknown`, ADR 0084), each holding's sector vector
   * is scaled by its derived equity weight: the non-equity part reads
   * `notApplicable`, and an equity sleeve the vector does not cover reads
   * `unknown`. The vector is relative to the equity sleeve, so the coverage's
   * three parts still partition gross exactly.
   */
  bySector: AgentViewExposureDimension;
  /**
   * The currency-risk lens (PRD #539, ADR 0039): the unhedged, non-base-currency
   * share of the portfolio, by currency. Informational exposure only — worthline
   * assumes the base currency for every figure, so this changes no valuation.
   */
  currencyRisk: AgentViewAllocationSlice[];
  concentration: {
    /** Largest single holding's weight of gross assets. */
    topHoldingWeight: string;
    /** Combined weight of the top five holdings. */
    topFiveWeight: string;
  };
}

/**
 * A security's resolved exposure profile as the holding detail exposes it (PRD
 * #539, ADR 0039): the tracked index, TER, hedged flag, and the per-dimension
 * breakdown vectors (`bucket → weight` decimal strings). Reference metadata, not
 * a figure — it never touches net worth, snapshots, or ripple. A holding with no
 * profile (or an instrument that takes none) reports `exposureProfile: null`; the
 * absence is signalled honestly and a profile is never fabricated.
 */
export interface AgentViewExposureProfile {
  trackedIndex: string | null;
  ter: string | null;
  hedged: boolean;
  breakdowns: {
    geography?: Record<string, string>;
    currency?: Record<string, string>;
    assetClass?: Record<string, string>;
    /**
     * The GICS-11 sector vector, relative to the instrument's equity sleeve
     * (PRD #1018, ADR 0065): weights sum to ≤ 1 over the equity part, never the
     * whole fund. Absent when the profile carries no sector data.
     */
    sector?: Record<string, string>;
  };
}

/** One year of projected look-through exposure under the contribution plan (#560). */
export interface AgentViewExposureDriftPoint {
  year: number;
  grossAssets: AgentViewMoney;
  byGeography: AgentViewExposureDimension;
  byAssetClass: AgentViewExposureDimension;
}

/**
 * Exposure-drift what-if under the contribution plan (ADR 0041, #560): how
 * geography and asset-class composition shift as planned contributions land.
 * Forecast only — same growth assumption as `whatIf`.
 */
export interface AgentViewExposureDrift {
  object: "exposure_drift";
  growthAssumption: "flat" | "historical";
  assumedAnnualReturn: string;
  status: "configured" | "empty";
  trajectory: AgentViewExposureDriftPoint[];
}

import Big from "big.js";

import type { DecimalString } from "./decimal";
import type {
  ExposureAssetClassBucket,
  ExposureDimension,
  ExposureGeographyBucket,
  ExposureSectorBucket,
} from "./exposure-taxonomy";
import type { Instrument } from "./instrument-catalog";
import type { CurrencyCode, MoneyMinor } from "./money";

type Breakdown = Record<string, DecimalString>;
type DimensionResolution =
  | { kind: "classified"; breakdown: Breakdown }
  | { kind: "not-applicable" }
  | { kind: "unknown" };

export interface ExposureBreakdowns {
  geography?: Partial<Record<ExposureGeographyBucket, DecimalString>>;
  currency?: Breakdown;
  assetClass?: Partial<Record<ExposureAssetClassBucket, DecimalString>>;
  /**
   * Sector vector relative to the holding's equity sleeve (sums ≤ 1 over the
   * equity part, not whole-fund — ADR 0065). The engine scales it by the
   * derived equity weight in S2; here it is storage only.
   */
  sector?: Partial<Record<ExposureSectorBucket, DecimalString>>;
}

export interface ExposureProfile {
  key: string;
  source: "user" | "agent";
  declaredAt: string | null;
  trackedIndex?: string | null;
  ter?: DecimalString | null;
  hedged?: boolean;
  breakdowns: ExposureBreakdowns;
}

export interface ExposureLookthroughHolding {
  id: string;
  valueMinor: number;
  currency: CurrencyCode;
  instrument: Instrument;
  geography?: ExposureGeographyBucket | null;
  isin?: string | null;
  providerSymbol?: string | null;
}

export interface ExposureAllocationSlice {
  key: string;
  value: MoneyMinor;
  weight: string;
}

export interface ExposureCoverage {
  classified: MoneyMinor;
  notApplicable: MoneyMinor;
  unknown: MoneyMinor;
}

export interface ExposureDimensionResult {
  slices: ExposureAllocationSlice[];
  coverage: ExposureCoverage;
}

export interface ExposureLookthrough {
  geography: ExposureDimensionResult;
  currency: ExposureDimensionResult;
  assetClass: ExposureDimensionResult;
  currencyRisk: ExposureAllocationSlice[];
}

export interface ExposureLookthroughInput {
  assetClassFilter?: ExposureAssetClassBucket;
  baseCurrency: CurrencyCode;
  grossAssets: MoneyMinor;
  holdings: readonly ExposureLookthroughHolding[];
  profiles: ReadonlyMap<string, ExposureProfile>;
}

const INVESTMENT_PROFILE_INSTRUMENTS = new Set<Instrument>([
  "fund",
  "etf",
  "stock",
  "index",
  "pension_plan",
]);

const AUTO_ASSET_CLASS_BY_INSTRUMENT: Partial<
  Record<Instrument, ExposureAssetClassBucket>
> = {
  coin_collection: "commodity",
  crypto: "crypto",
  current_account: "cash",
  precious_metal: "commodity",
  property: "property",
  term_deposit: "cash",
  vehicle: "commodity",
};

const GEO_CURRENCY_NOT_APPLICABLE_INSTRUMENTS = new Set<Instrument>([
  "coin_collection",
  "crypto",
  "current_account",
  "precious_metal",
  "term_deposit",
  "vehicle",
]);

/**
 * A holding's resolved asset-class breakdown: the profile's stored vector when
 * present, else the single auto-derived class for instruments without a hand-
 * entered profile (cash/property/crypto/commodity), else `unknown`. Asset class
 * has no `not-applicable` state — every holding either resolves to a class
 * breakdown or is unknown. The single source of truth for the asset-class axis:
 * both the look-through (`resolveDimension`) and per-asset-class returns (#552)
 * read the class from here, so grouping stays consistent with the exposure
 * surface (ADR 0039).
 */
export type AssetClassResolution =
  | { kind: "classified"; breakdown: Breakdown }
  | { kind: "unknown" };

export function resolveAssetClassBreakdown(
  instrument: Instrument,
  profile: ExposureProfile | null,
): AssetClassResolution {
  const stored = profile?.breakdowns.assetClass as Breakdown | undefined;
  if (stored && Object.keys(stored).length > 0) {
    return { breakdown: stored, kind: "classified" };
  }

  const autoClass = AUTO_ASSET_CLASS_BY_INSTRUMENT[instrument];
  return autoClass
    ? { breakdown: { [autoClass]: "1" }, kind: "classified" }
    : { kind: "unknown" };
}

/** Validates an imported exposure profile shape (workspace transfer, not a write factory). */
export function validateImportedExposureProfile(profile: {
  breakdowns?: ExposureBreakdowns;
}): void {
  const breakdowns = profile.breakdowns ?? {};
  for (const dimension of EXPOSURE_DIMENSIONS) {
    assertBreakdownTotal(breakdowns[dimension] as Breakdown | undefined, dimension);
  }
}

const EXPOSURE_DIMENSIONS: readonly ExposureDimension[] = [
  "geography",
  "currency",
  "assetClass",
];

export function lookThroughExposure(
  input: ExposureLookthroughInput,
): ExposureLookthrough {
  const currency = input.grossAssets.currency;
  const projectedHoldings = input.holdings
    .map((holding) => {
      const profile = resolveProfile(holding, input.profiles);
      return {
        holding,
        profile,
        valueMinor: filteredValueMinor(holding, profile, input.assetClassFilter),
      };
    })
    .filter((projection) => projection.valueMinor !== 0);
  const exposureGrossAssets: MoneyMinor = input.assetClassFilter
    ? {
        amountMinor: projectedHoldings.reduce(
          (sum, projection) => sum + projection.valueMinor,
          0,
        ),
        currency,
      }
    : input.grossAssets;
  const geographyTotals = new Map<string, number>();
  const currencyTotals = new Map<string, number>();
  const currencyRiskTotals = new Map<string, number>();
  const assetClassTotals = new Map<string, number>();
  const coverage = {
    assetClass: emptyCoverage(currency),
    currency: emptyCoverage(currency),
    geography: emptyCoverage(currency),
  };

  for (const { holding, profile, valueMinor } of projectedHoldings) {
    const filteredHolding = { ...holding, valueMinor };

    addProfileDimension({
      assetClassFilter: input.assetClassFilter,
      coverage: coverage.geography,
      dimension: "geography",
      holding: filteredHolding,
      profile,
      totals: geographyTotals,
    });
    addProfileDimension({
      assetClassFilter: input.assetClassFilter,
      coverage: coverage.currency,
      dimension: "currency",
      holding: filteredHolding,
      profile,
      totals: currencyTotals,
    });
    addProfileDimension({
      assetClassFilter: input.assetClassFilter,
      coverage: coverage.assetClass,
      dimension: "assetClass",
      holding: filteredHolding,
      profile,
      totals: assetClassTotals,
    });
    addCurrencyRisk(currencyRiskTotals, filteredHolding, profile, input.baseCurrency);
  }

  return {
    assetClass: {
      coverage: coverage.assetClass,
      slices: slicesFromTotals(assetClassTotals, exposureGrossAssets),
    },
    currency: {
      coverage: coverage.currency,
      slices: slicesFromTotals(currencyTotals, exposureGrossAssets),
    },
    currencyRisk: slicesFromTotals(currencyRiskTotals, exposureGrossAssets),
    geography: {
      coverage: coverage.geography,
      slices: slicesFromTotals(geographyTotals, exposureGrossAssets),
    },
  };
}

function resolveProfile(
  holding: ExposureLookthroughHolding,
  profiles: ReadonlyMap<string, ExposureProfile>,
): ExposureProfile | null {
  if (!INVESTMENT_PROFILE_INSTRUMENTS.has(holding.instrument)) {
    return null;
  }

  const key = holding.isin ?? holding.providerSymbol ?? null;
  return key ? (profiles.get(key) ?? null) : null;
}

function addProfileDimension(input: {
  assetClassFilter: ExposureAssetClassBucket | undefined;
  dimension: ExposureDimension;
  holding: ExposureLookthroughHolding;
  profile: ExposureProfile | null;
  totals: Map<string, number>;
  coverage: ExposureCoverage;
}): void {
  const resolution =
    input.dimension === "assetClass" && input.assetClassFilter
      ? ({
          breakdown: { [input.assetClassFilter]: "1" },
          kind: "classified",
        } as const)
      : resolveDimension(input.holding, input.profile, input.dimension);

  if (resolution.kind === "unknown") {
    input.coverage.unknown.amountMinor += input.holding.valueMinor;
    return;
  }

  if (resolution.kind === "not-applicable") {
    input.coverage.notApplicable.amountMinor += input.holding.valueMinor;
    return;
  }

  addBreakdown(input.totals, input.holding.valueMinor, resolution.breakdown);
  input.coverage.classified.amountMinor += input.holding.valueMinor;
}

function filteredValueMinor(
  holding: ExposureLookthroughHolding,
  profile: ExposureProfile | null,
  filter: ExposureAssetClassBucket | undefined,
): number {
  if (!filter) {
    return holding.valueMinor;
  }

  const resolution = resolveDimension(holding, profile, "assetClass");
  if (resolution.kind !== "classified") {
    return 0;
  }

  return multiplyMinorByWeight(holding.valueMinor, resolution.breakdown[filter] ?? "0");
}

function resolveDimension(
  holding: ExposureLookthroughHolding,
  profile: ExposureProfile | null,
  dimension: ExposureDimension,
): DimensionResolution {
  if (dimension === "assetClass") {
    return resolveAssetClassBreakdown(holding.instrument, profile);
  }

  const storedBreakdown = profile?.breakdowns[dimension] as Breakdown | undefined;
  if (storedBreakdown && Object.keys(storedBreakdown).length > 0) {
    return { breakdown: storedBreakdown, kind: "classified" };
  }

  if (holding.instrument === "property") {
    if (dimension === "geography") {
      return holding.geography
        ? { breakdown: { [holding.geography]: "1" }, kind: "classified" }
        : { kind: "unknown" };
    }

    return { breakdown: { [holding.currency]: "1" }, kind: "classified" };
  }

  if (GEO_CURRENCY_NOT_APPLICABLE_INSTRUMENTS.has(holding.instrument)) {
    return { kind: "not-applicable" };
  }

  return { kind: "unknown" };
}

function addBreakdown(
  totals: Map<string, number>,
  valueMinor: number,
  breakdown: Breakdown,
): void {
  for (const [key, amountMinor] of allocateBreakdown(valueMinor, breakdown)) {
    totals.set(key, (totals.get(key) ?? 0) + amountMinor);
  }
}

function addCurrencyRisk(
  totals: Map<string, number>,
  holding: ExposureLookthroughHolding,
  profile: ExposureProfile | null,
  baseCurrency: CurrencyCode,
): void {
  if (profile?.hedged === true) {
    return;
  }

  const breakdown = profile?.breakdowns.currency as Breakdown | undefined;
  if (breakdown && Object.keys(breakdown).length > 0) {
    for (const [currency, amountMinor] of allocateBreakdown(
      holding.valueMinor,
      breakdown,
    )) {
      if (currency === baseCurrency || currency === "other") {
        continue;
      }
      totals.set(currency, (totals.get(currency) ?? 0) + amountMinor);
    }
    return;
  }

  if (holding.currency !== baseCurrency) {
    totals.set(
      holding.currency,
      (totals.get(holding.currency) ?? 0) + holding.valueMinor,
    );
  }
}

function assertBreakdownTotal(
  breakdown: Breakdown | undefined,
  dimension: ExposureDimension,
): void {
  if (!breakdown) {
    return;
  }

  const total = Object.values(breakdown).reduce(
    (sum, weight) => sum.plus(weight),
    new Big(0),
  );

  if (total.gt(1)) {
    throw new Error(`Exposure profile ${dimension} breakdown cannot exceed 100%.`);
  }
}

function allocateBreakdown(
  valueMinor: number,
  breakdown: Breakdown,
): Array<[string, number]> {
  const weights = new Map<string, Big>();
  let total = new Big(0);

  for (const [key, weight] of Object.entries(breakdown)) {
    const parsed = new Big(weight);
    total = total.plus(parsed);
    weights.set(key, (weights.get(key) ?? new Big(0)).plus(parsed));
  }

  if (total.gt(1)) {
    throw new Error("Exposure profile breakdown cannot exceed 100%.");
  }

  if (total.lt(1)) {
    weights.set(
      "other",
      (weights.get("other") ?? new Big(0)).plus(new Big(1).minus(total)),
    );
  }

  const parts = [...weights.entries()].map(([key, weight]) => {
    const raw = new Big(valueMinor).times(weight);
    const floor = raw.round(0, Big.roundDown);
    return {
      amountMinor: Number(floor.toString()),
      key,
      remainder: raw.minus(floor),
    };
  });
  let remainingMinor =
    valueMinor - parts.reduce((sum, part) => sum + part.amountMinor, 0);

  for (const part of [...parts].sort(
    (a, b) => b.remainder.cmp(a.remainder) || a.key.localeCompare(b.key),
  )) {
    if (remainingMinor <= 0) break;
    part.amountMinor += 1;
    remainingMinor -= 1;
  }

  return parts
    .filter((part) => part.amountMinor !== 0)
    .map((part) => [part.key, part.amountMinor]);
}

function multiplyMinorByWeight(valueMinor: number, weight: DecimalString): number {
  return Number(new Big(valueMinor).times(weight).round(0, Big.roundHalfUp).toString());
}

function slicesFromTotals(
  totals: ReadonlyMap<string, number>,
  grossAssets: MoneyMinor,
): ExposureAllocationSlice[] {
  return [...totals.entries()]
    .map(([key, amountMinor]) => ({
      key,
      value: { amountMinor, currency: grossAssets.currency },
      weight: weightOf(amountMinor, grossAssets.amountMinor),
    }))
    .sort(
      (a, b) => b.value.amountMinor - a.value.amountMinor || a.key.localeCompare(b.key),
    );
}

function emptyCoverage(currency: CurrencyCode): ExposureCoverage {
  return {
    classified: { amountMinor: 0, currency },
    notApplicable: { amountMinor: 0, currency },
    unknown: { amountMinor: 0, currency },
  };
}

function weightOf(amountMinor: number, grossMinor: number): string {
  if (grossMinor === 0) {
    return "0";
  }

  return ratioStringFromBps(Math.round((amountMinor * 10_000) / grossMinor));
}

function ratioStringFromBps(bps: number): string {
  const sign = bps < 0 ? "-" : "";
  const abs = Math.abs(bps);
  const whole = Math.floor(abs / 10_000);
  const fraction = (abs % 10_000).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

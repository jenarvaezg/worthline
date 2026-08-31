import Big from "big.js";

import { isDateKeyShaped } from "./dates";
import type { DecimalString } from "./decimal";
import {
  type GlobalExposureProfileIdentity,
  type RawGlobalExposureProfileIdentityInput,
  resolveGlobalExposureProfileIdentity,
} from "./exposure-identity";
import type {
  ExposureGeographyBucket,
  ExposureGeographyWeightKey,
  ExposureSectorBucket,
} from "./exposure-taxonomy";
import {
  CURRENCY_NOT_APPLICABLE_KEY,
  EXPOSURE_GEOGRAPHY_BUCKETS,
  EXPOSURE_SECTOR_BUCKETS,
  GEOGRAPHY_NOT_APPLICABLE_KEY,
} from "./exposure-taxonomy";
import type { CurrencyCode } from "./money";

/** Geography buckets allowed in the global catalog — same closed set as workspace v1. */
export type GlobalExposureGeographyBucket = ExposureGeographyBucket;

/** Keys a catalog geography vector may store: the six regions plus `sin_region` (#1499). */
export type GlobalExposureGeographyWeightKey = ExposureGeographyWeightKey;

/**
 * Sector buckets allowed in the global catalog — the fixed GICS-11 enum. Unlike
 * geography/assetClass the sector vector is read **relative to the equity
 * sleeve** (sums ≤ 1 over the equity part), not whole-fund (ADR 0065, #940 S4).
 */
export type GlobalExposureSectorBucket = ExposureSectorBucket;

/** Asset-class buckets in the global catalog — `mixed` is intentionally excluded (#940). */
export type GlobalExposureAssetClassBucket =
  | "equity"
  | "bond"
  | "cash"
  | "commodity"
  | "property"
  | "crypto";

export const GLOBAL_EXPOSURE_ASSET_CLASS_BUCKETS = [
  "equity",
  "bond",
  "cash",
  "commodity",
  "property",
  "crypto",
] as const satisfies readonly GlobalExposureAssetClassBucket[];

export interface GlobalExposureProfileBreakdowns {
  geography?: Partial<Record<GlobalExposureGeographyWeightKey, DecimalString>>;
  currency?: Record<string, DecimalString>;
  assetClass?: Partial<Record<GlobalExposureAssetClassBucket, DecimalString>>;
  /** Sector vector as a fraction of the equity sleeve (≤ 1), never whole-fund (ADR 0065). */
  sector?: Partial<Record<GlobalExposureSectorBucket, DecimalString>>;
}

/**
 * How much a vector is worth believing (#1508), with the same three levels the
 * catalog pass already uses in its workshop:
 *
 * - `alta` — index factsheet or trivially-composed product; verifiable to the decimal.
 * - `media` — issuer/distributor breakdown with a translated taxonomy, or an
 *   "other" bucket split by hand.
 * - `baja` — no published breakdown: the vector reads the fund's MANDATE, not
 *   its portfolio.
 *
 * A row with no declared confidence is `null` — «sin declarar», which is the
 * truth about every row written before this seam existed. It is never silently
 * promoted to a level.
 */
export type GlobalExposureProfileConfidence = "alta" | "media" | "baja";

/** The three levels, worst-first — the order a triage register wants. */
export const GLOBAL_EXPOSURE_PROFILE_CONFIDENCES = [
  "baja",
  "media",
  "alta",
] as const satisfies readonly GlobalExposureProfileConfidence[];

export interface GlobalExposureProfile {
  identity: GlobalExposureProfileIdentity;
  displayName: string | null;
  breakdowns: GlobalExposureProfileBreakdowns;
  ter: DecimalString | null;
  trackedIndex: string | null;
  hedgedToCurrency: CurrencyCode | null;
  /** How much the vector is worth believing, or `null` when undeclared (#1508). */
  confidence: GlobalExposureProfileConfidence | null;
  /**
   * Cut-off day of the DATA (`YYYY-MM-DD`), never the day it was written —
   * that is what lets a vector age. `null` when undeclared (#1508).
   */
  asOfDate: string | null;
  /** Short free text naming where the vector came from (#1508). */
  sources: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalExposureProfileContentInput {
  displayName?: string | null;
  breakdowns?: GlobalExposureProfileBreakdowns;
  ter?: DecimalString | null;
  trackedIndex?: string | null;
  hedgedToCurrency?: string | null;
  confidence?: string | null;
  asOfDate?: string | null;
  sources?: string | null;
}

export interface CreateGlobalExposureProfileInput
  extends GlobalExposureProfileContentInput {
  identity: RawGlobalExposureProfileIdentityInput;
}

export interface UpdateGlobalExposureProfileInput
  extends GlobalExposureProfileContentInput {}

const ISO_4217_PATTERN = /^[A-Z]{3}$/;
/** `sources` is a short label («factsheet MSCI 31/07/2026»), not a bibliography. */
const MAX_SOURCES_LENGTH = 300;
const GEOGRAPHY_BUCKETS = new Set<string>([
  ...EXPOSURE_GEOGRAPHY_BUCKETS,
  GEOGRAPHY_NOT_APPLICABLE_KEY,
]);
const ASSET_CLASS_BUCKETS = new Set<string>(GLOBAL_EXPOSURE_ASSET_CLASS_BUCKETS);
const SECTOR_BUCKETS = new Set<string>(EXPOSURE_SECTOR_BUCKETS);

export interface ValidatedGlobalExposureProfileContent {
  displayName: string | null;
  breakdowns: GlobalExposureProfileBreakdowns;
  ter: DecimalString | null;
  trackedIndex: string | null;
  hedgedToCurrency: CurrencyCode | null;
  confidence: GlobalExposureProfileConfidence | null;
  asOfDate: string | null;
  sources: string | null;
}

export function validateGlobalExposureProfileContent(
  input: GlobalExposureProfileContentInput,
): ValidatedGlobalExposureProfileContent {
  const displayName = normalizeOptionalText(input.displayName);
  const trackedIndex = normalizeOptionalText(input.trackedIndex);
  const hedgedToCurrency = normalizeCurrency(input.hedgedToCurrency);
  const ter = normalizeTer(input.ter);
  const breakdowns = normalizeBreakdowns(input.breakdowns ?? {});
  const confidence = normalizeConfidence(input.confidence);
  const asOfDate = normalizeAsOfDate(input.asOfDate);
  const sources = normalizeSources(input.sources);

  // Provenance deliberately does NOT count as content: «confianza baja, a fecha
  // de abril de 2024» describes a vector, so there has to be a vector. A row
  // whose only content is its own provenance says nothing about a security.
  if (
    displayName === null &&
    trackedIndex === null &&
    hedgedToCurrency === null &&
    ter === null &&
    isBreakdownEmpty(breakdowns)
  ) {
    throw new Error("Exposure profile content cannot be completely empty.");
  }

  return {
    asOfDate,
    breakdowns,
    confidence,
    displayName,
    hedgedToCurrency,
    sources,
    ter,
    trackedIndex,
  };
}

export function createValidatedGlobalExposureProfileInput(
  input: CreateGlobalExposureProfileInput,
): ValidatedGlobalExposureProfileContent & {
  identity: GlobalExposureProfileIdentity;
} {
  return {
    identity: resolveGlobalExposureProfileIdentity(input.identity),
    ...validateGlobalExposureProfileContent(input),
  };
}

function normalizeBreakdowns(
  breakdowns: GlobalExposureProfileBreakdowns,
): GlobalExposureProfileBreakdowns {
  const normalized: GlobalExposureProfileBreakdowns = {};
  const geography = normalizeDimensionBreakdown(
    breakdowns.geography,
    GEOGRAPHY_BUCKETS,
    "geography",
  );
  if (geography) {
    normalized.geography = geography;
  }
  const currency = normalizeOpenDimensionBreakdown(breakdowns.currency, "currency");
  if (currency) {
    normalized.currency = currency;
  }
  const assetClass = normalizeDimensionBreakdown(
    breakdowns.assetClass,
    ASSET_CLASS_BUCKETS,
    "assetClass",
  );
  if (assetClass) {
    normalized.assetClass = assetClass;
  }
  const sector = normalizeDimensionBreakdown(breakdowns.sector, SECTOR_BUCKETS, "sector");
  if (sector) {
    normalized.sector = sector;
  }
  return normalized;
}

function normalizeDimensionBreakdown<T extends string>(
  breakdown: Partial<Record<T, DecimalString>> | undefined,
  allowedBuckets: Set<string>,
  dimension: string,
): Partial<Record<T, DecimalString>> | undefined {
  if (!breakdown) {
    return undefined;
  }

  const normalized: Partial<Record<T, DecimalString>> = {};
  for (const [bucket, weight] of Object.entries(breakdown) as Array<[T, DecimalString]>) {
    if (!allowedBuckets.has(bucket)) {
      throw new Error(`Exposure profile ${dimension} bucket "${bucket}" is not allowed.`);
    }
    const parsedWeight = parseWeight(weight, dimension, bucket);
    normalized[bucket] = parsedWeight;
  }

  assertBreakdownTotal(normalized as Record<string, DecimalString>, dimension);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeOpenDimensionBreakdown(
  breakdown: Record<string, DecimalString> | undefined,
  dimension: string,
): Record<string, DecimalString> | undefined {
  if (!breakdown) {
    return undefined;
  }

  const normalized: Record<string, DecimalString> = {};
  for (const [bucket, weight] of Object.entries(breakdown)) {
    if (bucket === CURRENCY_NOT_APPLICABLE_KEY) {
      normalized[CURRENCY_NOT_APPLICABLE_KEY] = parseWeight(
        weight,
        dimension,
        CURRENCY_NOT_APPLICABLE_KEY,
      );
      continue;
    }
    const currency = bucket.toUpperCase();
    if (!ISO_4217_PATTERN.test(currency)) {
      throw new Error(
        `Exposure profile currency bucket "${bucket}" must be ISO-4217 uppercase.`,
      );
    }
    normalized[currency] = parseWeight(weight, dimension, currency);
  }

  assertBreakdownTotal(normalized, dimension);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseWeight(
  weight: DecimalString,
  dimension: string,
  bucket: string,
): DecimalString {
  const parsed = new Big(weight);
  if (parsed.lt(0) || parsed.gt(1)) {
    throw new Error(
      `Exposure profile ${dimension} weight for "${bucket}" must be between 0 and 1.`,
    );
  }
  return parsed.toString() as DecimalString;
}

function assertBreakdownTotal(
  breakdown: Record<string, DecimalString>,
  dimension: string,
): void {
  const total = Object.values(breakdown).reduce(
    (sum, weight) => sum.plus(weight),
    new Big(0),
  );
  if (total.gt(1)) {
    throw new Error(`Exposure profile ${dimension} breakdown cannot exceed 100%.`);
  }
}

function isBreakdownEmpty(breakdowns: GlobalExposureProfileBreakdowns): boolean {
  return (
    !breakdowns.geography &&
    !breakdowns.currency &&
    !breakdowns.assetClass &&
    !breakdowns.sector
  );
}

function normalizeTer(value: DecimalString | null | undefined): DecimalString | null {
  const normalized = trimToNull(value);
  if (normalized === null) {
    return null;
  }
  const parsed = new Big(normalized);
  if (parsed.lt(0) || parsed.gt(1)) {
    throw new Error("Exposure profile TER must be between 0 and 1.");
  }
  return parsed.toString() as DecimalString;
}

function normalizeCurrency(value: string | null | undefined): CurrencyCode | null {
  const normalized = trimToNull(value)?.toUpperCase() ?? null;
  if (normalized === null) {
    return null;
  }
  if (!ISO_4217_PATTERN.test(normalized)) {
    throw new Error("Exposure profile hedgedToCurrency must be ISO-4217 uppercase.");
  }
  return normalized as CurrencyCode;
}

function normalizeConfidence(
  value: string | null | undefined,
): GlobalExposureProfileConfidence | null {
  const normalized = trimToNull(value)?.toLowerCase() ?? null;
  if (normalized === null) {
    return null;
  }
  if (!(GLOBAL_EXPOSURE_PROFILE_CONFIDENCES as readonly string[]).includes(normalized)) {
    throw new Error("Exposure profile confidence must be alta, media or baja.");
  }
  return normalized as GlobalExposureProfileConfidence;
}

/**
 * The cut-off day of the data, validated as a real calendar day — a shape check
 * alone would let `2026-02-30` through and an ordering by antiquity would then
 * sort on a day that does not exist. Clock-free on purpose: a future cut-off is
 * the admin's problem to see, not this function's to guess (ADR 0039).
 */
function normalizeAsOfDate(value: string | null | undefined): string | null {
  const normalized = trimToNull(value);
  if (normalized === null) {
    return null;
  }
  if (!isDateKeyShaped(normalized) || !isRealCalendarDay(normalized)) {
    throw new Error(
      "Exposure profile asOfDate must be a real calendar day in YYYY-MM-DD format.",
    );
  }
  return normalized;
}

function isRealCalendarDay(dateKey: string): boolean {
  const parsed = new Date(`${dateKey}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateKey;
}

function normalizeSources(value: string | null | undefined): string | null {
  const normalized = trimToNull(value);
  if (normalized === null) {
    return null;
  }
  if (normalized.length > MAX_SOURCES_LENGTH) {
    throw new Error(
      `Exposure profile sources must be ${MAX_SOURCES_LENGTH} characters or fewer.`,
    );
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  return trimToNull(value);
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

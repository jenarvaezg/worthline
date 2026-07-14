import Big from "big.js";

import type { DecimalString } from "./decimal";
import type { ExposureGeographyBucket } from "./exposure-taxonomy";
import { EXPOSURE_GEOGRAPHY_BUCKETS } from "./exposure-taxonomy";
import type { CurrencyCode } from "./money";
import type { InvestmentPriceProvider } from "./prices";

/** Geography buckets allowed in the global catalog — same closed set as workspace v1. */
export type GlobalExposureGeographyBucket = ExposureGeographyBucket;

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

export type GlobalExposureProfileIdentity =
  | { kind: "isin"; isin: string }
  | {
      kind: "provider";
      priceProvider: InvestmentPriceProvider;
      providerSymbol: string;
    };

export interface GlobalExposureProfileBreakdowns {
  geography?: Partial<Record<GlobalExposureGeographyBucket, DecimalString>>;
  currency?: Record<string, DecimalString>;
  assetClass?: Partial<Record<GlobalExposureAssetClassBucket, DecimalString>>;
}

export interface GlobalExposureProfile {
  identity: GlobalExposureProfileIdentity;
  displayName: string | null;
  breakdowns: GlobalExposureProfileBreakdowns;
  ter: DecimalString | null;
  trackedIndex: string | null;
  hedgedToCurrency: CurrencyCode | null;
  createdAt: string;
  updatedAt: string;
}

export interface RawGlobalExposureProfileIdentityInput {
  isin?: string | null;
  priceProvider?: string | null;
  providerSymbol?: string | null;
}

export interface GlobalExposureProfileContentInput {
  displayName?: string | null;
  breakdowns?: GlobalExposureProfileBreakdowns;
  ter?: DecimalString | null;
  trackedIndex?: string | null;
  hedgedToCurrency?: string | null;
}

export interface CreateGlobalExposureProfileInput
  extends GlobalExposureProfileContentInput {
  identity: RawGlobalExposureProfileIdentityInput;
}

export interface UpdateGlobalExposureProfileInput
  extends GlobalExposureProfileContentInput {}

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const ISO_4217_PATTERN = /^[A-Z]{3}$/;
const INVESTMENT_PRICE_PROVIDERS = new Set<InvestmentPriceProvider>([
  "yahoo",
  "stooq",
  "finect",
  "coingecko",
]);
const GEOGRAPHY_BUCKETS = new Set<string>(EXPOSURE_GEOGRAPHY_BUCKETS);
const ASSET_CLASS_BUCKETS = new Set<string>(GLOBAL_EXPOSURE_ASSET_CLASS_BUCKETS);

export function globalExposureProfileIdentityKey(
  identity: GlobalExposureProfileIdentity,
): string {
  return identity.kind === "isin"
    ? identity.isin
    : `p:${identity.priceProvider}:${identity.providerSymbol}`;
}

export function isValidIsin(value: string): boolean {
  if (!ISIN_PATTERN.test(value)) {
    return false;
  }

  const expanded = [...value]
    .map((character) => {
      if (character >= "0" && character <= "9") {
        return character;
      }
      return String(character.charCodeAt(0) - 55);
    })
    .join("");

  let sum = 0;
  let alternate = false;
  for (let index = expanded.length - 1; index >= 0; index -= 1) {
    let digit = Number(expanded[index]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    alternate = !alternate;
  }

  return sum % 10 === 0;
}

export function resolveGlobalExposureProfileIdentity(
  input: RawGlobalExposureProfileIdentityInput,
): GlobalExposureProfileIdentity {
  const trimmedIsin = trimToNull(input.isin);
  if (trimmedIsin) {
    const normalized = trimmedIsin.toUpperCase();
    if (isValidIsin(normalized)) {
      return { isin: normalized, kind: "isin" };
    }
  }

  const priceProvider = trimToNull(input.priceProvider);
  const providerSymbol = trimPreserveCase(input.providerSymbol);
  if (priceProvider && providerSymbol) {
    return {
      kind: "provider",
      priceProvider: assertInvestmentPriceProvider(priceProvider),
      providerSymbol,
    };
  }

  throw new Error(
    "Exposure profile identity requires a valid ISIN or priceProvider + providerSymbol.",
  );
}

export function validateGlobalExposureProfileContent(
  input: GlobalExposureProfileContentInput,
): {
  displayName: string | null;
  breakdowns: GlobalExposureProfileBreakdowns;
  ter: DecimalString | null;
  trackedIndex: string | null;
  hedgedToCurrency: CurrencyCode | null;
} {
  const displayName = normalizeOptionalText(input.displayName);
  const trackedIndex = normalizeOptionalText(input.trackedIndex);
  const hedgedToCurrency = normalizeCurrency(input.hedgedToCurrency);
  const ter = normalizeTer(input.ter);
  const breakdowns = normalizeBreakdowns(input.breakdowns ?? {});

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
    breakdowns,
    displayName,
    hedgedToCurrency,
    ter,
    trackedIndex,
  };
}

export function createValidatedGlobalExposureProfileInput(
  input: CreateGlobalExposureProfileInput,
): {
  identity: GlobalExposureProfileIdentity;
  displayName: string | null;
  breakdowns: GlobalExposureProfileBreakdowns;
  ter: DecimalString | null;
  trackedIndex: string | null;
  hedgedToCurrency: CurrencyCode | null;
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
  return !breakdowns.geography && !breakdowns.currency && !breakdowns.assetClass;
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

function normalizeOptionalText(value: string | null | undefined): string | null {
  return trimToNull(value);
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function trimPreserveCase(value: string | null | undefined): string | null {
  return trimToNull(value);
}

function assertInvestmentPriceProvider(value: string): InvestmentPriceProvider {
  if (!INVESTMENT_PRICE_PROVIDERS.has(value as InvestmentPriceProvider)) {
    throw new Error(`Unknown price provider "${value}".`);
  }
  return value as InvestmentPriceProvider;
}

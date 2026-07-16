import Big from "big.js";

import type { DecimalString } from "./decimal";

export const EXPOSURE_GEOGRAPHY_BUCKETS = [
  "us",
  "europe_developed",
  "japan",
  "pacific_developed",
  "emerging",
  "other",
] as const;

export type ExposureGeographyBucket = (typeof EXPOSURE_GEOGRAPHY_BUCKETS)[number];

export const EXPOSURE_ASSET_CLASS_BUCKETS = [
  "equity",
  "bond",
  "cash",
  "commodity",
  "property",
  "crypto",
  "mixed",
] as const;

export type ExposureAssetClassBucket = (typeof EXPOSURE_ASSET_CLASS_BUCKETS)[number];

/**
 * The 11 GICS level-1 sectors — a fixed canonical enum, coarse like geography
 * because the vector is hand-entered (no free feed). Unlike geography /
 * assetClass, the sector vector is read **relative to a holding's equity
 * sleeve** (sums ≤ 1 over the equity part), never whole-fund — see
 * ADR 0065. v1 is look-through only. [#1002]
 */
export const EXPOSURE_SECTOR_BUCKETS = [
  "energy",
  "materials",
  "industrials",
  "consumer_discretionary",
  "consumer_staples",
  "health_care",
  "financials",
  "information_technology",
  "communication_services",
  "utilities",
  "real_estate",
] as const;

export type ExposureSectorBucket = (typeof EXPOSURE_SECTOR_BUCKETS)[number];

export type ExposureDimension = "geography" | "currency" | "assetClass" | "sector";

/** Spanish labels for geography buckets — reused by admin CRUD (S4). */
export const EXPOSURE_GEOGRAPHY_LABELS: ReadonlyArray<{
  bucket: ExposureGeographyBucket;
  label: string;
}> = [
  { bucket: "us", label: "EE. UU." },
  { bucket: "europe_developed", label: "Europa desarrollada" },
  { bucket: "japan", label: "Japón" },
  { bucket: "pacific_developed", label: "Pacífico desarrollado" },
  { bucket: "emerging", label: "Emergentes" },
  { bucket: "other", label: "Otros" },
];

/** Spanish labels for asset-class buckets — reused by admin CRUD (S4). */
export const EXPOSURE_ASSET_CLASS_LABELS: ReadonlyArray<{
  bucket: ExposureAssetClassBucket;
  label: string;
}> = [
  { bucket: "equity", label: "Renta variable" },
  { bucket: "bond", label: "Renta fija" },
  { bucket: "cash", label: "Efectivo" },
  { bucket: "commodity", label: "Materia prima" },
  { bucket: "property", label: "Inmobiliario" },
  { bucket: "crypto", label: "Cripto" },
  { bucket: "mixed", label: "Mixto" },
];

/** Spanish labels for sector buckets — reused by admin CRUD (S4). Mirrors geography. */
export const EXPOSURE_SECTOR_LABELS: ReadonlyArray<{
  bucket: ExposureSectorBucket;
  label: string;
}> = [
  { bucket: "energy", label: "Energía" },
  { bucket: "materials", label: "Materiales" },
  { bucket: "industrials", label: "Industria" },
  { bucket: "consumer_discretionary", label: "Consumo discrecional" },
  { bucket: "consumer_staples", label: "Consumo básico" },
  { bucket: "health_care", label: "Salud" },
  { bucket: "financials", label: "Financiero" },
  { bucket: "information_technology", label: "Tecnología" },
  { bucket: "communication_services", label: "Servicios de comunicación" },
  { bucket: "utilities", label: "Servicios públicos" },
  { bucket: "real_estate", label: "Inmobiliario" },
];

/**
 * The "defensive" style lens (ADR 0065): a *derived* view over the sector
 * vector, never a bucket you can store or edit. These three GICS sectors are
 * canonically defensive; every other sector is cyclical.
 */
export const EXPOSURE_DEFENSIVE_SECTORS: ReadonlySet<ExposureSectorBucket> = new Set([
  "consumer_staples",
  "utilities",
  "health_care",
]);

/**
 * Split a sector vector into defensive vs cyclical weight. Pure derived lens:
 * it sums the raw stored weights into the two groups without renormalising, so
 * the two totals add up to the vector's declared coverage (≤ 1 — an under-100%
 * vector leaves the remainder unclassified, exactly as the coverage box shows).
 * A partial or empty vector returns `"0"` for the absent side. Never introduces
 * a bucket — "defensive" is a marker, not a slice.
 */
export function sectorStyleSplit(
  vector: Partial<Record<ExposureSectorBucket, DecimalString>>,
): { defensive: DecimalString; cyclical: DecimalString } {
  let defensive = new Big(0);
  let cyclical = new Big(0);

  for (const [bucket, weight] of Object.entries(vector)) {
    if (weight == null) {
      continue;
    }
    const parsed = new Big(weight);
    if (EXPOSURE_DEFENSIVE_SECTORS.has(bucket as ExposureSectorBucket)) {
      defensive = defensive.plus(parsed);
    } else {
      cyclical = cyclical.plus(parsed);
    }
  }

  return { cyclical: cyclical.toString(), defensive: defensive.toString() };
}

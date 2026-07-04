import type {
  ExposureAssetClassBucket,
  ExposureCoverage,
  ExposureDimensionResult,
  ExposureGeographyBucket,
  ExposureLookthrough,
  MoneyMinor,
} from "@worthline/domain";

import type { ExposureLens } from "@web/view-state";

/**
 * Pure among-state logic for the /patrimonio exposure section (PRD #539 S3, #543,
 * interaction-patterns §7). The client island is a thin shell; everything it
 * decides lives here so it unit-tests in the node env with no React/DOM:
 *   - which pre-rendered geography breakdown a lens shows (`geographyForLens`),
 *   - how a `0..1` exposure weight ratio prints as an es-ES percent,
 *   - the Spanish label for a geography bucket key,
 *   - the three-way coverage split, ordered and labelled, with zero parts kept
 *     so an absent `unknown` remainder is shown as 0 % and never silently hidden.
 * The aggregation itself is the S0 domain `lookThroughExposure` — never redone.
 */

/** MSCI geography buckets → Spanish labels (mirrors the S1 hand-entry form). */
const GEOGRAPHY_LABELS: Record<ExposureGeographyBucket, string> = {
  us: "EE. UU.",
  europe_developed: "Europa desarrollada",
  japan: "Japón",
  pacific_developed: "Pacífico desarrollado",
  emerging: "Emergentes",
  other: "Otros",
};

/** The Spanish label for a geography slice key, or the raw key if unrecognised. */
export function geographyLabel(key: string): string {
  return GEOGRAPHY_LABELS[key as ExposureGeographyBucket] ?? key;
}

/**
 * Asset-class buckets → Spanish labels, plus the two non-bucket keys the returns
 * decomposition emits: `other` (a breakdown's declared-under-100% remainder) and
 * `unclassified` (a holding with no resolvable class). Mirrors the S1 hand-entry
 * vocabulary (#552).
 */
const ASSET_CLASS_LABELS: Record<
  ExposureAssetClassBucket | "other" | "unclassified",
  string
> = {
  bond: "Renta fija",
  cash: "Efectivo",
  commodity: "Materias primas",
  crypto: "Cripto",
  equity: "Renta variable",
  mixed: "Mixto",
  other: "Otros",
  property: "Inmobiliario",
  unclassified: "Sin clasificar",
};

/** The Spanish label for an asset-class slice key, or the raw key if unrecognised. */
export function assetClassLabel(key: string): string {
  return (
    ASSET_CLASS_LABELS[key as ExposureAssetClassBucket | "other" | "unclassified"] ?? key
  );
}

/**
 * Render a `0..1` decimal-string weight (as emitted by `lookThroughExposure`) as
 * a whole-percent es-ES string, e.g. `"0.4"` → `"40 %"`. Weights are exact
 * ratios, so rounding to a whole percent is a display choice, not a data loss.
 */
export function formatExposureWeight(weight: string): string {
  const percent = Math.round(Number(weight) * 100);
  return `${percent.toLocaleString("es-ES")} %`;
}

/**
 * The geography breakdown to show for the chosen lens: the full-portfolio
 * look-through for `"all"`, the equity-restricted one for `"equity"`. Both are
 * pre-rendered server-side, so the island only picks (no refetch, §2).
 */
export function geographyForLens(
  lens: ExposureLens,
  full: ExposureLookthrough,
  equity: ExposureLookthrough,
): ExposureDimensionResult {
  return lens === "equity" ? equity.geography : full.geography;
}

/** One labelled slice of the three-way coverage readout. */
export interface ExposureCoveragePart {
  kind: "classified" | "notApplicable" | "unknown";
  label: string;
  value: MoneyMinor;
}

/**
 * The coverage split as three ordered, labelled parts. Every part is kept even
 * at zero: the point of the three-way readout is that an `unknown` remainder is
 * never hidden and `not-applicable` (crypto/cash) is labelled as such, not as
 * missing (#543 acceptance).
 */
export function coverageParts(coverage: ExposureCoverage): ExposureCoveragePart[] {
  return [
    { kind: "classified", label: "Clasificado", value: coverage.classified },
    { kind: "notApplicable", label: "No aplica", value: coverage.notApplicable },
    { kind: "unknown", label: "Sin clasificar", value: coverage.unknown },
  ];
}

import {
  assetClassLabel,
  coverageParts,
  formatExposureWeight,
  geographyLabel,
} from "@web/patrimonio/exposure-view";
import type { ExposureDriftPoint, FireGrowthAssumption } from "@worthline/domain";

export const EXPOSURE_DRIFT_GROWTH_PARAM = "driftGrowth";
export const EXPOSURE_DRIFT_YEAR_PARAM = "driftYear";

/** Parse the growth-assumption toggle from the URL; defaults to historical. */
export function parseExposureDriftGrowth(raw: string | undefined): FireGrowthAssumption {
  return raw === "flat" ? "flat" : "historical";
}

/** Pick a trajectory year from the URL, clamped to available points. */
export function parseExposureDriftYear(
  raw: string | undefined,
  trajectory: ExposureDriftPoint[],
): number {
  const years = trajectory.map((point) => point.year);
  if (years.length === 0) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return years.at(-1) ?? 0;
  }
  const closest = years.reduce((best, year) =>
    Math.abs(year - parsed) < Math.abs(best - parsed) ? year : best,
  );
  return closest;
}

export function exposureDriftGrowthUrl(
  currentHref: string,
  growth: FireGrowthAssumption,
): string {
  const url = new URL(currentHref);
  if (growth === "historical") {
    url.searchParams.delete(EXPOSURE_DRIFT_GROWTH_PARAM);
  } else {
    url.searchParams.set(EXPOSURE_DRIFT_GROWTH_PARAM, growth);
  }
  return `${url.pathname}${url.search}`;
}

export function exposureDriftYearUrl(currentHref: string, year: number): string {
  const url = new URL(currentHref);
  url.searchParams.set(EXPOSURE_DRIFT_YEAR_PARAM, String(year));
  return `${url.pathname}${url.search}`;
}

export { assetClassLabel, coverageParts, formatExposureWeight, geographyLabel };

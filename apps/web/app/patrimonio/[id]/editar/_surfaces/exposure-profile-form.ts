/**
 * Pure exposure-profile form logic (PRD #539 S1, #541).
 *
 * All the parsing + among-fields maths for the hand-entry surface lives here
 * (interaction-patterns §7): the field map → exposure-profile write input (geography
 * percents → decimal-string fractions, TER percent → fraction, asset class →
 * single-bucket vector), the geography `Otros` remainder shown to the user, and
 * the >100% validation gate (delegated to the domain's `createExposureProfile`).
 * No React, no DB, no Next.js — the section component and the server action are
 * thin glue over this.
 */

import { parsePercentToDecimal } from "@web/intake";
import type {
  CreateExposureProfileInput,
  DecimalString,
  ExposureAssetClassBucket,
  ExposureBreakdowns,
  ExposureGeographyBucket,
  ExposureProfile,
} from "@worthline/domain";
import {
  createExposureProfile,
  EXPOSURE_ASSET_CLASS_BUCKETS,
  EXPOSURE_GEOGRAPHY_BUCKETS,
} from "@worthline/domain";

/** The raw string map lifted straight off the form (percents 0–100, es-ES ok). */
export interface ExposureProfileFields {
  geography: Record<ExposureGeographyBucket, string>;
  /** One of EXPOSURE_ASSET_CLASS_BUCKETS, or "" for none. */
  assetClass: string;
  /** TER as a percent, e.g. "0,22" meaning 0.22%. */
  ter: string;
  trackedIndex: string;
  hedged: boolean;
}

/** The MSCI geography buckets in render order, with their Spanish labels. */
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

/** The asset-class buckets in render order, with their Spanish labels. */
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

/** A geography percent that is present (non-blank) after trimming. */
function isFilled(raw: string): boolean {
  return raw.trim() !== "";
}

/** Whether every field is blank — the submission means "clear this profile". */
export function isEmptyExposureFields(fields: ExposureProfileFields): boolean {
  const geoBlank = EXPOSURE_GEOGRAPHY_BUCKETS.every(
    (bucket) => !isFilled(fields.geography[bucket]),
  );

  return (
    geoBlank &&
    !isFilled(fields.assetClass) &&
    !isFilled(fields.ter) &&
    !isFilled(fields.trackedIndex) &&
    !fields.hedged
  );
}

/**
 * The undeclared geography remainder as a percentage (100 − Σ of the entered
 * buckets). Shown to the user so a sub-100 vector makes visible what is left as
 * implicit "Otros"; a negative value means the entered weights exceed 100% and
 * the submission will be blocked (see {@link buildExposureProfileResult}).
 */
export function geographyRemainderPercent(
  geography: Record<ExposureGeographyBucket, string>,
): number {
  // Sum through the SAME parser the save path uses (parsePercentToDecimal →
  // fraction) so the on-screen remainder can never contradict what a submit
  // actually stores. Work in fractions, then back to a percent for display.
  const sumFraction = EXPOSURE_GEOGRAPHY_BUCKETS.reduce((total, bucket) => {
    const raw = geography[bucket];
    if (!isFilled(raw)) return total;
    const fraction = parsePercentToDecimal(raw);
    return total + (fraction === null ? 0 : Number(fraction));
  }, 0);

  return Math.round((100 - sumFraction * 100) * 1e6) / 1e6;
}

/** Build the geography breakdown, omitting blank buckets entirely (never "0"). */
function parseGeography(
  geography: Record<ExposureGeographyBucket, string>,
): Partial<Record<ExposureGeographyBucket, DecimalString>> | undefined {
  const breakdown: Partial<Record<ExposureGeographyBucket, DecimalString>> = {};

  for (const bucket of EXPOSURE_GEOGRAPHY_BUCKETS) {
    const raw = geography[bucket];
    if (!isFilled(raw)) continue;
    const fraction = parsePercentToDecimal(raw);
    if (fraction !== null) {
      breakdown[bucket] = fraction;
    }
  }

  return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

/**
 * The single asset class as a one-bucket vector `{ [class]: "1" }`. v1 models a
 * fund as 100% one class; a 60/40 mixed fund is a v1 limitation the vector model
 * already supports for finer entry later.
 * ponytail: single-class only — the ExposureBreakdowns vector already allows
 * `{ equity: "0.6", bond: "0.4" }`; add multi-class inputs when a real 60/40
 * fund needs it, not before.
 */
function parseAssetClass(
  assetClass: string,
): Partial<Record<ExposureAssetClassBucket, DecimalString>> | undefined {
  const trimmed = assetClass.trim();

  return (EXPOSURE_ASSET_CLASS_BUCKETS as readonly string[]).includes(trimmed)
    ? { [trimmed as ExposureAssetClassBucket]: "1" }
    : undefined;
}

/**
 * Turn the raw field map into a profile write for the given key — the pure parse
 * with NO validation (validation is {@link buildExposureProfileResult}).
 * Percents become decimal-string fractions; TER percent (0.22%) becomes a
 * fraction ("0.0022"); the single asset class becomes a one-bucket vector.
 */
export function parseExposureProfileFields(
  key: string,
  fields: ExposureProfileFields,
): CreateExposureProfileInput & { breakdowns: ExposureBreakdowns } {
  const breakdowns: ExposureBreakdowns = {};
  const geography = parseGeography(fields.geography);
  breakdowns.geography = geography ?? {};
  const assetClass = parseAssetClass(fields.assetClass);
  breakdowns.assetClass = assetClass ?? {};

  const ter = isFilled(fields.ter) ? parsePercentToDecimal(fields.ter) : null;
  const trackedIndex = fields.trackedIndex.trim();

  return {
    key,
    trackedIndex: trackedIndex || null,
    ter,
    hedged: fields.hedged,
    breakdowns,
  };
}

/** The validated build outcome: a profile, or a Spanish error to surface. */
export type ExposureProfileResult =
  | { ok: true; profile: ExposureProfile }
  | { ok: false; error: string };

/**
 * Parse AND validate: build the profile then run it through the domain's
 * `createExposureProfile`, which throws when any dimension's weights sum > 100%.
 * The throw is translated to the Spanish message the page shows in its errorBand
 * (interaction-patterns §4: no silent swallow). Kept here — not in the action —
 * so the whole >100% path is unit-testable without Next.js.
 */
export function buildExposureProfileResult(
  key: string,
  fields: ExposureProfileFields,
): ExposureProfileResult {
  const profile = parseExposureProfileFields(key, fields);

  try {
    return { ok: true, profile: createExposureProfile(profile) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    return { ok: false, error: translateExposureError(message) };
  }
}

/** Map the domain's English breakdown-overflow message to a Spanish one. */
function translateExposureError(message: string): string {
  if (message.includes("geography")) {
    return "El reparto geográfico no puede superar el 100%.";
  }
  if (message.includes("currency")) {
    return "El reparto por divisa no puede superar el 100%.";
  }
  if (message.includes("assetClass")) {
    return "El reparto por clase de activo no puede superar el 100%.";
  }
  return "El reparto de exposición no puede superar el 100%.";
}

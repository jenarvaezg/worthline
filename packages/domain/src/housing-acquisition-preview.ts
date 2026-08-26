import { daysBetween } from "./dates";
import type { DecimalString } from "./decimal";
import { type HousingValuationAnchor, valueHousingAtDate } from "./housing-valuation";
import type { ValuationCadence } from "./valuation-cadence";

/**
 * What editing a housing's ACQUISITION anchor would do to its value curve
 * (#1562), computed before anything is written.
 *
 * The acquisition is the oldest point of a property's history, so moving its
 * date or its price redraws every day between it and the next market appraisal
 * — 22 years of interpolated curve in the measured case. That is a
 * reconstruction, not a field edit, and it deserves the same preview→confirm
 * ceremony as one (ADR 0070 §4): this module says what the curve looked like,
 * what it will look like, and on which dates.
 *
 * Both sides are valued by the SAME engine the ripple writes with
 * (`valueHousingAtDate`, #1438) — a preview computed by a second engine is a
 * preview that can lie. Pure: every date comes in as a parameter.
 */

/** The two fields of the acquisition anchor this preview compares. */
export interface AcquisitionAnchorFields {
  /** YYYY-MM-DD. */
  valuationDate: string;
  /** Integer minor units — the acquisition price (a TOTAL, never an increment). */
  valueMinor: number;
}

/** What a compared date IS on the curve, so the surface can name it. */
export type HousingCurveDateRole =
  | "acquisition_current"
  | "acquisition_new"
  | "appraisal"
  | "improvement"
  | "curve"
  | "today";

/** One date, valued on both curves. */
export interface HousingCurveComparisonPoint {
  dateKey: string;
  role: HousingCurveDateRole;
  /** The curve as it stands today, in integer minor units. */
  beforeMinor: number;
  /** The curve the edit would write, in integer minor units. */
  afterMinor: number;
  /** `afterMinor - beforeMinor` — signed, and 0 when the date does not move. */
  deltaMinor: number;
}

export interface AcquisitionEditPreviewInput {
  /**
   * Every anchor of the asset EXCEPT the acquisition one (market appraisals and
   * improvements). The acquisition rides in through `current`/`edited`, so the
   * two curves differ in exactly that anchor.
   */
  otherAnchors: readonly HousingValuationAnchor[];
  /** The acquisition anchor as stored — the curve as it stands. */
  current: AcquisitionAnchorFields;
  /** The acquisition anchor the edit would write. */
  edited: AcquisitionAnchorFields;
  annualAppreciationRate?: DecimalString | null;
  cadence?: ValuationCadence | null;
  /** The asset's stored current value, the curve's "today" value. */
  currentValueMinor: number;
  /** "Today" as YYYY-MM-DD — a parameter, never the clock. */
  today: string;
}

export interface AcquisitionEditPreview {
  /**
   * The earliest date the rewrite reaches: the EARLIER of the stored and the
   * edited acquisition date — the same rule the ripple derives behind its seam.
   */
  fromDateKey: string;
  dateChanged: boolean;
  valueChanged: boolean;
  /** The compared dates, ascending, each listed once. */
  points: HousingCurveComparisonPoint[];
}

/** How many interior samples of the redrawn stretch the comparison carries. */
const STRETCH_SAMPLES = 2;

/** `dateKey` shifted by whole days, as a date key. UTC, so no DST drift. */
function shiftDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Dates INSIDE the stretch the edit redraws, evenly spaced.
 *
 * Without them a price-only edit would compare the acquisition (moves) against
 * the next appraisal (holds — it is the truth at its date) and nothing else: a
 * table of one moving row, while 22 years of interpolated curve move between
 * them unseen. These are the samples that make the redraw visible; a stretch too
 * short to hold a sample gets none.
 */
function stretchSamples(
  fromDateKey: string,
  stretchEnd: string,
  sampleCount = STRETCH_SAMPLES,
): string[] {
  const span = daysBetween(fromDateKey, stretchEnd);
  if (span < sampleCount + 1) return [];
  const step = span / (sampleCount + 1);
  return Array.from({ length: sampleCount }, (_, index) =>
    shiftDays(fromDateKey, Math.round(step * (index + 1))),
  );
}

/**
 * Where the redrawn stretch ends: the first market appraisal after BOTH
 * acquisition dates (it is the total truth at its date, so the curve rejoins
 * there), else today — with no later appraisal the whole curve rides the
 * acquisition.
 */
function stretchEndOf(input: AcquisitionEditPreviewInput): string {
  const latestAcquisition =
    input.current.valuationDate > input.edited.valuationDate
      ? input.current.valuationDate
      : input.edited.valuationDate;
  return (
    input.otherAnchors
      .filter(
        (anchor) => anchor.adjustsPriorCurve && anchor.valuationDate > latestAcquisition,
      )
      .map((anchor) => anchor.valuationDate)
      .sort()[0] ?? input.today
  );
}

/** The acquisition is a market appraisal: its price is the TOTAL truth at its date. */
function asAppraisal(fields: AcquisitionAnchorFields): HousingValuationAnchor {
  return {
    adjustsPriorCurve: true,
    valuationDate: fields.valuationDate,
    valueMinor: fields.valueMinor,
  };
}

/** Role of a compared date; the acquisition wins over an anchor sharing its date. */
function roleOf(
  dateKey: string,
  input: AcquisitionEditPreviewInput,
): HousingCurveDateRole {
  if (dateKey === input.edited.valuationDate) return "acquisition_new";
  if (dateKey === input.current.valuationDate) return "acquisition_current";
  const anchor = input.otherAnchors.find((a) => a.valuationDate === dateKey);
  if (anchor) return anchor.adjustsPriorCurve ? "appraisal" : "improvement";
  return dateKey === input.today ? "today" : "curve";
}

export function buildAcquisitionEditPreview(
  input: AcquisitionEditPreviewInput,
): AcquisitionEditPreview {
  const { current, edited, otherAnchors, today } = input;
  const before = [...otherAnchors, asAppraisal(current)];
  const after = [...otherAnchors, asAppraisal(edited)];

  const shared = {
    annualAppreciationRate: input.annualAppreciationRate ?? null,
    currentValueMinor: input.currentValueMinor,
    today,
    ...(input.cadence != null ? { cadence: input.cadence } : {}),
  };

  const fromDateKey =
    current.valuationDate < edited.valuationDate
      ? current.valuationDate
      : edited.valuationDate;

  const dateKeys = [
    ...new Set([
      current.valuationDate,
      edited.valuationDate,
      ...stretchSamples(fromDateKey, stretchEndOf(input)),
      ...otherAnchors.map((anchor) => anchor.valuationDate),
      today,
    ]),
  ].sort();

  return {
    dateChanged: current.valuationDate !== edited.valuationDate,
    fromDateKey,
    points: dateKeys.map((dateKey) => {
      const beforeMinor = valueHousingAtDate({
        ...shared,
        anchors: before,
        targetDate: dateKey,
      });
      const afterMinor = valueHousingAtDate({
        ...shared,
        anchors: after,
        targetDate: dateKey,
      });
      return {
        afterMinor,
        beforeMinor,
        dateKey,
        deltaMinor: afterMinor - beforeMinor,
        role: roleOf(dateKey, input),
      };
    }),
    valueChanged: current.valueMinor !== edited.valueMinor,
  };
}

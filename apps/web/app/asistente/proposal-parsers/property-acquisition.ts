/**
 * Trust boundary for a property-acquisition proposal (#1563).
 *
 * Every field the card renders is checked, `rows` and `points` element by element:
 * this shape crosses to the client through a stream, so the card must never be the
 * first thing to find out a figure is missing.
 */

import type { PropertyAcquisitionProposal } from "@web/asistente/property-acquisition-proposal-contract";
import { parsePropertyAcquisitionProposalDraft } from "@web/asistente/property-acquisition-proposal-contract";
import type {
  HousingCurveComparisonPoint,
  HousingCurveDateRole,
} from "@worthline/domain";
import {
  isOneOf,
  isRecord,
  parseAll,
  parseBeforeAfterRow,
  parseNamedRef,
  parseStrings,
  vocabulary,
} from "./shapes";

const DATE_ROLES = vocabulary<HousingCurveDateRole>({
  acquisition_current: true,
  acquisition_new: true,
  appraisal: true,
  curve: true,
  improvement: true,
  today: true,
});

/** One date valued on both curves — the stretch that moves, not just its endpoints. */
function parseComparisonPoint(raw: unknown): HousingCurveComparisonPoint | null {
  if (!isRecord(raw)) return null;
  const { afterMinor, beforeMinor, dateKey, deltaMinor, role } = raw;
  if (typeof dateKey !== "string" || !isOneOf(role, DATE_ROLES)) return null;
  if (typeof beforeMinor !== "number" || typeof afterMinor !== "number") return null;
  if (typeof deltaMinor !== "number") return null;
  return { afterMinor, beforeMinor, dateKey, deltaMinor, role };
}

export function parsePropertyAcquisitionProposal(
  raw: unknown,
): PropertyAcquisitionProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "property_acquisition") return null;
  const draft = parsePropertyAcquisitionProposalDraft(raw.draft);
  const property = parseNamedRef(raw.property);
  const rows = parseAll(raw.rows, parseBeforeAfterRow);
  const points = parseAll(raw.points, parseComparisonPoint);
  const notes = parseStrings(raw.notes);
  const { folio, summary } = raw;
  if (!draft.ok || property === null || rows === null) return null;
  if (points === null || notes === null) return null;
  if (typeof summary !== "string" || typeof folio !== "string") return null;
  return {
    draft: draft.draft,
    folio,
    notes,
    points,
    property,
    proposalType: "property_acquisition",
    rows,
    summary,
  };
}

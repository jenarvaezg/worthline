/**
 * Trust boundary for a property valuation-anchor proposal (#1240): the anchor a
 * document declared and the curve it redraws. The trust tier is pinned by the
 * contract — a valuation read off a document is `unverified` and always needs review.
 */

import type { PropertyValuationProposal } from "@web/asistente/property-valuation-proposal-contract";
import { parsePropertyValuationProposalDraft } from "@web/asistente/property-valuation-proposal-contract";
import { isRecord, parseAll, parseNamedRef, parseValueCurvePoint } from "./shapes";

function parseAnchor(raw: unknown): PropertyValuationProposal["anchor"] | null {
  if (!isRecord(raw)) return null;
  const { valuationDate, valueMinor } = raw;
  if (typeof valuationDate !== "string" || typeof valueMinor !== "number") return null;
  return { valuationDate, valueMinor };
}

export function parsePropertyValuationProposal(
  raw: unknown,
): PropertyValuationProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "property_valuation_anchor") return null;
  const draft = parsePropertyValuationProposalDraft(raw.draft);
  const property = parseNamedRef(raw.property);
  const anchor = parseAnchor(raw.anchor);
  const curve = parseAll(raw.curve, parseValueCurvePoint);
  if (!draft.ok || property === null || anchor === null || curve === null) return null;
  if (!isRecord(raw.trust)) return null;
  if (raw.trust.tier !== "unverified" || raw.trust.requiresReview !== true) return null;
  return {
    anchor,
    curve,
    draft: draft.draft,
    property,
    proposalType: "property_valuation_anchor",
    trust: { requiresReview: true, tier: "unverified" },
  };
}

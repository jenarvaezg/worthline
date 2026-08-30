/**
 * Trust boundary for a mixed-document proposal (ADR 0059): one document that carried
 * several kinds of evidence, each segment routed through the typed projector of its
 * own family. `kind` closes each section's preview.
 */

import type {
  MixedDocumentProposal,
  MixedDocumentSection,
  MixedTrust,
} from "@web/asistente/mixed-document-proposals";
import {
  isOneOf,
  isRecord,
  parseAll,
  parseBalanceCurvePoint,
  parseDebtHistoryPoint,
  parseFundPreviewRow,
  parseNamedRef,
  parsePositionImpact,
  parseValueCurvePoint,
} from "./shapes";

const TIERS: readonly MixedTrust["tier"][] = ["reconciled", "unverified", "mismatch"];

function parseTrust(raw: unknown): MixedTrust | null {
  if (!isRecord(raw)) return null;
  const { requiresReview, tier } = raw;
  if (!isOneOf(tier, TIERS) || typeof requiresReview !== "boolean") return null;
  return { requiresReview, tier };
}

function parseValuationAnchor(
  raw: unknown,
): { assetId: string; valuationDate: string; valueMinor: number } | null {
  if (!isRecord(raw)) return null;
  const { assetId, valuationDate, valueMinor } = raw;
  if (typeof assetId !== "string" || typeof valuationDate !== "string") return null;
  if (typeof valueMinor !== "number") return null;
  return { assetId, valuationDate, valueMinor };
}

/**
 * One classified segment. An empty investment or property segment is refused: a
 * section that previews nothing is not a section the user can decide on.
 */
function parseSection(raw: unknown): MixedDocumentSection | null {
  if (!isRecord(raw) || typeof raw.assetKey !== "string") return null;
  const { assetKey } = raw;
  if (!isRecord(raw.preview)) return null;
  const preview = raw.preview;
  const trust = parseTrust(preview.trust);
  if (trust === null) return null;

  if (raw.kind === "investment_statement") {
    const funds = parseAll(preview.funds, parseFundPreviewRow);
    if (funds === null || funds.length === 0) return null;
    if (!isRecord(preview.reconciliation)) return null;
    const { matches, positionImpact } = preview.reconciliation;
    const impact = parsePositionImpact(positionImpact);
    if (impact === null || typeof matches !== "boolean") return null;
    return {
      assetKey,
      kind: "investment_statement",
      preview: { funds, reconciliation: { matches, positionImpact: impact }, trust },
    };
  }

  if (raw.kind === "debt_balance_history") {
    const liability = parseNamedRef(preview.liability);
    const points = parseAll(preview.points, parseDebtHistoryPoint);
    const curve = parseAll(preview.curve, parseBalanceCurvePoint);
    if (liability === null || points === null || curve === null) return null;
    if (!isRecord(preview.reconciliation)) return null;
    const { expectedMinor, matches, resultingMinor } = preview.reconciliation;
    if (typeof expectedMinor !== "number" || typeof resultingMinor !== "number") {
      return null;
    }
    if (typeof matches !== "boolean") return null;
    return {
      assetKey,
      kind: "debt_balance_history",
      preview: {
        curve,
        liability,
        points,
        reconciliation: { expectedMinor, matches, resultingMinor },
        trust,
      },
    };
  }

  if (raw.kind !== "property_valuation") return null;
  const property = parseNamedRef(preview.property);
  const anchors = parseAll(preview.anchors, parseValuationAnchor);
  const curve = parseAll(preview.curve, parseValueCurvePoint);
  if (property === null || anchors === null || curve === null) return null;
  if (anchors.length === 0) return null;
  return {
    assetKey,
    kind: "property_valuation",
    preview: { anchors, curve, property, trust },
  };
}

export function parseMixedDocumentProposal(raw: unknown): MixedDocumentProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "mixed_document_import") return null;
  if (!isRecord(raw.draft) || typeof raw.draft.proposalId !== "string") return null;
  const sections = parseAll(raw.sections, parseSection);
  if (sections === null) return null;
  return {
    draft: { proposalId: raw.draft.proposalId },
    proposalType: "mixed_document_import",
    sections,
  };
}

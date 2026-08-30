/**
 * Trust boundary for an alta proposal (#1105, PRD #1103 S2): the holding as it would
 * be created, its net-worth impact (nullable on both ends when the read degraded,
 * ADR 0048) and the informative warnings that never block.
 */

import type { OpeningCardBreakdown } from "@web/asistente/holding-creation-opening";
import type {
  HoldingCreationDuplicate,
  HoldingCreationProposal,
} from "@web/asistente/holding-creation-proposal-contract";
import { parseHoldingCreationProposalDraft } from "@web/asistente/holding-creation-proposal-contract";
import type { HoldingCreationFamily } from "@worthline/db";
import {
  isOneOf,
  isOptionalNumber,
  isOptionalString,
  isRecord,
  parseNetWorthImpact,
  parseOptional,
  vocabulary,
} from "./shapes";

const FAMILIES = vocabulary<HoldingCreationFamily>({
  appreciating: true,
  debt: true,
  investment: true,
  stored: true,
});

const DUPLICATE_CONFIDENCES = vocabulary<HoldingCreationDuplicate["confidence"]>({
  strong: true,
  weak: true,
});

/** The opening BUY the card breaks down so a derived 3,018148 is visible (#1315). */
function parseOpening(raw: unknown): OpeningCardBreakdown | null {
  if (!isRecord(raw)) return null;
  const { fees, pricePerUnit, units } = raw;
  if (typeof units !== "string" || typeof pricePerUnit !== "string") return null;
  if (!isOptionalString(fees)) return null;
  return { pricePerUnit, units, ...(fees === undefined ? {} : { fees }) };
}

function parseDuplicate(raw: unknown): HoldingCreationDuplicate | null {
  if (!isRecord(raw)) return null;
  const { confidence, name, otherCandidates } = raw;
  if (typeof name !== "string" || !isOneOf(confidence, DUPLICATE_CONFIDENCES)) {
    return null;
  }
  if (!isOptionalNumber(otherCandidates)) return null;
  return {
    confidence,
    name,
    ...(otherCandidates === undefined ? {} : { otherCandidates }),
  };
}

function parseHolding(raw: unknown): HoldingCreationProposal["holding"] | null {
  if (!isRecord(raw)) return null;
  const { detail, instrumentLabel, name, opening, providerSymbol } = raw;
  if (typeof name !== "string" || typeof instrumentLabel !== "string") return null;
  if (typeof detail !== "string" || !isOptionalString(providerSymbol)) return null;
  const breakdown = parseOptional(opening, parseOpening);
  if (breakdown === null) return null;
  return {
    detail,
    instrumentLabel,
    name,
    ...(breakdown === undefined ? {} : { opening: breakdown }),
    ...(providerSymbol === undefined ? {} : { providerSymbol }),
  };
}

export function parseHoldingCreationProposal(
  raw: unknown,
): HoldingCreationProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "holding_creation") return null;
  const draft = parseHoldingCreationProposalDraft(raw.draft);
  const holding = parseHolding(raw.holding);
  const impact = parseNetWorthImpact(raw.impact);
  const {
    acquisitionTodayWarning,
    duplicate,
    family,
    folio,
    openingMismatchWarning,
    openingQuoteNote,
    priceTrackingWarning,
  } = raw;
  if (draft === null || holding === null || impact === null) return null;
  if (typeof folio !== "string" || !isOneOf(family, FAMILIES)) return null;
  if (
    !isOptionalString(priceTrackingWarning) ||
    !isOptionalString(acquisitionTodayWarning) ||
    !isOptionalString(openingMismatchWarning) ||
    !isOptionalString(openingQuoteNote)
  ) {
    return null;
  }
  const parsedDuplicate = parseOptional(duplicate, parseDuplicate);
  if (parsedDuplicate === null) return null;
  return {
    draft,
    family,
    folio,
    holding,
    impact,
    proposalType: "holding_creation",
    ...(parsedDuplicate === undefined ? {} : { duplicate: parsedDuplicate }),
    ...(acquisitionTodayWarning === undefined ? {} : { acquisitionTodayWarning }),
    ...(openingMismatchWarning === undefined ? {} : { openingMismatchWarning }),
    ...(openingQuoteNote === undefined ? {} : { openingQuoteNote }),
    ...(priceTrackingWarning === undefined ? {} : { priceTrackingWarning }),
  };
}

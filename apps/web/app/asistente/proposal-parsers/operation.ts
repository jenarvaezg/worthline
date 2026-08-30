/**
 * Trust boundary for an operation proposal (#1374). Every rendered figure is a STRING
 * the server already formatted — the fact line, the participaciones, the destination —
 * so the card cannot re-derive money, a quantity or a date.
 */

import type { OperationKindClaim } from "@web/asistente/operation-document-frontier";
import type { OperationProposal } from "@web/asistente/operation-proposal-contract";
import { parseOperationProposalDraft } from "@web/asistente/operation-proposal-contract";
import {
  isOneOf,
  isRecord,
  parseNetWorthImpact,
  parseStrings,
  vocabulary,
} from "./shapes";

const KINDS = vocabulary<OperationKindClaim>({
  buy: true,
  contribution: true,
  sell: true,
});

/**
 * The source of the fact — the document's own words, or what worthline read in the
 * user's message (#1466) — printed apart from the destination. The caption travels with
 * it and is required: a card that fell back to «En el documento» for a dictated
 * operation would misstate its provenance.
 */
function parseDocument(raw: unknown): OperationProposal["document"] | null {
  if (!isRecord(raw)) return null;
  const { caption, fact, line } = raw;
  if (typeof line !== "string" || typeof fact !== "string") return null;
  if (typeof caption !== "string") return null;
  return { caption, fact, line };
}

/** Where the operation lands, by NAME (an id is machinery, #1263). */
function parseHolding(raw: unknown): OperationProposal["holding"] | null {
  if (!isRecord(raw)) return null;
  const { destination, id, name } = raw;
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (typeof destination !== "string") return null;
  return { destination, id, name };
}

function parsePosition(raw: unknown): OperationProposal["position"] | null {
  if (!isRecord(raw)) return null;
  const { unitsAfter, unitsBefore } = raw;
  if (typeof unitsBefore !== "string" || typeof unitsAfter !== "string") return null;
  return { unitsAfter, unitsBefore };
}

export function parseOperationProposal(raw: unknown): OperationProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "investment_operation") return null;
  const draft = parseOperationProposalDraft(raw.draft);
  const document = parseDocument(raw.document);
  const holding = parseHolding(raw.holding);
  const position = parsePosition(raw.position);
  const impact = parseNetWorthImpact(raw.impact);
  const notes = parseStrings(raw.notes);
  const { folio, impactCaption, kind, summary } = raw;
  if (!draft.ok || document === null || holding === null) return null;
  if (position === null || impact === null || notes === null) return null;
  if (typeof summary !== "string" || typeof folio !== "string") return null;
  if (typeof impactCaption !== "string" || !isOneOf(kind, KINDS)) return null;
  return {
    document,
    draft: draft.draft,
    folio,
    holding,
    impact,
    impactCaption,
    kind,
    notes,
    position,
    proposalType: "investment_operation",
    summary,
  };
}

/**
 * Trust boundary for a traspaso proposal (#1482). Same contract as the operation's:
 * every rendered figure is a STRING the server formatted — the echo of what worthline
 * read in the message, both movement lines, both positions, the inherited cost — so
 * the card cannot re-derive an importe, a VL or a quantity of participaciones.
 */

import type {
  TransferProposal,
  TransferProposalSide,
} from "@web/asistente/transfer-proposal-contract";
import { parseTransferProposalDraft } from "@web/asistente/transfer-proposal-contract";
import { isRecord, parseNetWorthImpact, parseStrings } from "./shapes";

/** One side of the pair, as the card prints it: two sentences and nothing else. */
function parseSide(raw: unknown): TransferProposalSide | null {
  if (!isRecord(raw)) return null;
  const { movementLine, positionLine } = raw;
  if (typeof positionLine !== "string" || typeof movementLine !== "string") return null;
  return { movementLine, positionLine };
}

export function parseTransferProposal(raw: unknown): TransferProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "investment_transfer") return null;
  const draft = parseTransferProposalDraft(raw.draft);
  const origin = parseSide(raw.origin);
  const destination = parseSide(raw.destination);
  const impact = parseNetWorthImpact(raw.impact);
  const notes = parseStrings(raw.notes);
  const { dictated, folio, impactCaption, inheritedCost, summary } = raw;
  if (!draft.ok || origin === null || destination === null) return null;
  if (impact === null || notes === null) return null;
  if (typeof summary !== "string" || typeof folio !== "string") return null;
  if (typeof dictated !== "string" || typeof inheritedCost !== "string") return null;
  if (typeof impactCaption !== "string") return null;
  return {
    destination,
    dictated,
    draft: draft.draft,
    folio,
    impact,
    impactCaption,
    inheritedCost,
    notes,
    origin,
    proposalType: "investment_transfer",
    summary,
  };
}

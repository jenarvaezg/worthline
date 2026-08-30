/**
 * Trust boundary for a baja/restauración proposal (#1106, PRD #1103 S3). The two
 * mirror operations share one shape; `proposalType` pins which one is expected, so a
 * removal payload can never paint a restoration card.
 */

import type {
  HoldingTrashDuplicate,
  HoldingTrashLine,
  HoldingTrashOrphanPair,
  HoldingTrashProposal,
} from "@web/asistente/holding-trash-proposal-contract";
import { parseHoldingTrashProposalDraft } from "@web/asistente/holding-trash-proposal-contract";
import { isOneOf, isRecord, parseAll, parseNetWorthImpact, vocabulary } from "./shapes";

const LINE_KINDS = vocabulary<HoldingTrashLine["kind"]>({ asset: true, liability: true });
const CONFIDENCES = vocabulary<HoldingTrashDuplicate["confidence"]>({
  strong: true,
  weak: true,
});

function parseLine(raw: unknown): HoldingTrashLine | null {
  if (!isRecord(raw)) return null;
  const { contributionMinor, detail, holdingId, instrumentLabel, kind, name } = raw;
  const { sharedOwnership } = raw;
  if (typeof holdingId !== "string" || typeof name !== "string") return null;
  if (typeof instrumentLabel !== "string" || typeof detail !== "string") return null;
  if (!isOneOf(kind, LINE_KINDS) || typeof contributionMinor !== "number") return null;
  if (typeof sharedOwnership !== "boolean") return null;
  return {
    contributionMinor,
    detail,
    holdingId,
    instrumentLabel,
    kind,
    name,
    sharedOwnership,
  };
}

function parseOrphanPair(raw: unknown): HoldingTrashOrphanPair | null {
  if (!isRecord(raw)) return null;
  const { assetName, debtName } = raw;
  if (typeof debtName !== "string" || typeof assetName !== "string") return null;
  return { assetName, debtName };
}

function parseDuplicate(raw: unknown): HoldingTrashDuplicate | null {
  if (!isRecord(raw)) return null;
  const { confidence, liveName, name } = raw;
  if (typeof name !== "string" || typeof liveName !== "string") return null;
  if (!isOneOf(confidence, CONFIDENCES)) return null;
  return { confidence, liveName, name };
}

export function parseHoldingTrashProposal(
  raw: unknown,
  proposalType: "holding_removal" | "holding_restoration",
): HoldingTrashProposal | null {
  if (!isRecord(raw) || raw.proposalType !== proposalType) return null;
  const draft = parseHoldingTrashProposalDraft(raw.draft);
  const lines = parseAll(raw.lines, parseLine);
  const orphanPairs = parseAll(raw.orphanPairs, parseOrphanPair);
  const duplicates = parseAll(raw.duplicates, parseDuplicate);
  const impact = parseNetWorthImpact(raw.impact);
  const { folio, operation } = raw;
  if (draft === null || lines === null || orphanPairs === null) return null;
  if (duplicates === null || impact === null) return null;
  if (typeof folio !== "string") return null;
  if (operation !== "remove" && operation !== "restore") return null;
  return {
    draft,
    duplicates,
    folio,
    impact,
    lines,
    operation,
    orphanPairs,
    proposalType,
  };
}

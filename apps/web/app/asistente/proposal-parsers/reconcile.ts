/**
 * Trust boundary for a reconcile proposal (#1108, PRD #1103 S5).
 *
 * The rows are not display-only: the card holds them as EDITABLE state and runs them
 * back through the domain matcher when the user reassigns one, so a row is only worth
 * painting when it carries the whole match — its candidates included. The movement
 * evidence (#1373) is checked for the same reason the card prints it: a row whose
 * shape this version does not carry would otherwise show a `+0 €` header with no
 * evidence under it, which is the very bug that put the evidence there.
 */

import type { HoldingFidelity } from "@web/asistente/attachment-extraction-contract";
import {
  HOLDING_FIDELITY_TIERS,
  MOVEMENT_KINDS,
} from "@web/asistente/attachment-extraction-contract";
import type { ReconcileRow, ReconcileRowMovement } from "@web/asistente/reconcile-plan";
import type { ReconcileProposal } from "@web/asistente/reconcile-proposal-contract";
import { parseReconcileProposalDraft } from "@web/asistente/reconcile-proposal-contract";
import type {
  Instrument,
  MatchCandidate,
  MatchConfidence,
  MatchDecision,
  MatchKey,
  RowMatch,
  SecurityId,
} from "@worthline/domain";
import { classifySecurityId, INSTRUMENTS, validIsinOrNull } from "@worthline/domain";
import {
  isNullableNumber,
  isOneOf,
  isOptionalBoolean,
  isOptionalNumber,
  isOptionalString,
  isRecord,
  parseAll,
  parseOptional,
  vocabulary,
} from "./shapes";

const KEYS = vocabulary<MatchKey>({
  dgs: true,
  isin: true,
  name: true,
  none: true,
  provider_symbol: true,
});
const DECISIONS = vocabulary<MatchDecision>({ create: true, leave: true, update: true });
const CONFIDENCES = vocabulary<MatchConfidence>({
  none: true,
  strong: true,
  weak: true,
});

function parseCandidate(raw: unknown): MatchCandidate | null {
  if (!isRecord(raw)) return null;
  const { confidence, holdingId, key, name } = raw;
  if (typeof holdingId !== "string" || typeof name !== "string") return null;
  if (!isOneOf(key, KEYS) || !isOneOf(confidence, CONFIDENCES)) return null;
  return { confidence, holdingId, key, name };
}

/** The per-row decision, with everything a reassignment needs to be re-derived. */
function parseMatch(raw: unknown): RowMatch | null {
  if (!isRecord(raw)) return null;
  const { ambiguous, candidates, confidence, decision, key, rowId, target } = raw;
  if (typeof rowId !== "string" || !isOneOf(decision, DECISIONS)) return null;
  if (!isOneOf(confidence, CONFIDENCES) || !isOneOf(key, KEYS)) return null;
  if (!isOptionalString(target) || !isOptionalBoolean(ambiguous)) return null;
  const parsedCandidates = parseAll(candidates, parseCandidate);
  if (parsedCandidates === null) return null;
  const duplicate = parseOptional(raw.possibleDuplicate, parseCandidate);
  if (duplicate === null) return null;
  return {
    candidates: parsedCandidates,
    confidence,
    decision,
    key,
    rowId,
    ...(ambiguous === undefined ? {} : { ambiguous }),
    ...(duplicate === undefined ? {} : { possibleDuplicate: duplicate }),
    ...(target === undefined ? {} : { target }),
  };
}

/**
 * The row's typed identifier as it comes back off the wire (#1747). Re-classified
 * rather than trusted: the pair must still say what its VALUE says, so a client
 * cannot hand back `{kind: "isin", value: "N5394"}` and route a plan down the ISIN
 * lane. An identifier that will not classify is dropped — the row keeps its name and
 * its match, and the surface degrades to what it can honestly show.
 */
function parseSecurityId(raw: unknown): SecurityId | undefined {
  if (!isRecord(raw)) return undefined;
  const { kind, value } = raw;
  if (typeof value !== "string") return undefined;
  const classified = classifySecurityId(value);
  return classified && classified.kind === kind ? classified : undefined;
}

/**
 * The row's identifier, reading the legacy shape too (#1747). A proposal drafted
 * before the pair existed persisted a bare `isin`, and a pending one has to
 * re-hydrate with the identifier it was drafted with: without this the card would
 * quietly stop printing the ISIN it printed yesterday, and the contradiction the
 * document line exists to expose would go with it. Same legacy-reader pattern the
 * column migration used (#1743).
 */
function parseRowSecurityId(raw: Record<string, unknown>): SecurityId | undefined {
  const typed = parseSecurityId(raw.securityId);
  if (typed) return typed;
  const legacy = typeof raw.isin === "string" ? validIsinOrNull(raw.isin) : null;
  return legacy ? { kind: "isin", value: legacy } : undefined;
}

/** One movement the document attributes to a row — the evidence of what will be written. */
function parseMovement(raw: unknown): ReconcileRowMovement | null {
  if (!isRecord(raw)) return null;
  const { currency, date, kind, signedAmountMinor, unitPrice, units } = raw;
  if (typeof date !== "string" || !isOneOf(kind, MOVEMENT_KINDS)) return null;
  if (typeof signedAmountMinor !== "number" || typeof currency !== "string") return null;
  if (!isOptionalNumber(units) || !isOptionalNumber(unitPrice)) return null;
  return {
    currency,
    date,
    kind,
    signedAmountMinor,
    ...(unitPrice === undefined ? {} : { unitPrice }),
    ...(units === undefined ? {} : { units }),
  };
}

function parseRow(raw: unknown): ReconcileRow | null {
  if (!isRecord(raw)) return null;
  const { currency, declaredCostMinor, excluded, fidelity, instrument } = raw;
  const { movementsDeltaMinor, name, rowId, uncertain, valueMinor } = raw;
  if (typeof rowId !== "string" || typeof name !== "string") return null;
  if (!isOptionalNumber(declaredCostMinor)) return null;
  const securityId = parseRowSecurityId(raw);
  if (instrument !== null && !isOneOf(instrument, INSTRUMENTS)) return null;
  if (!isOneOf(fidelity, HOLDING_FIDELITY_TIERS)) return null;
  if (typeof valueMinor !== "number" || typeof currency !== "string") return null;
  if (typeof movementsDeltaMinor !== "number") return null;
  if (typeof excluded !== "boolean" || typeof uncertain !== "boolean") return null;
  const movements = parseAll(raw.movements, parseMovement);
  const match = parseMatch(raw.match);
  if (movements === null || match === null) return null;
  return {
    currency,
    excluded,
    fidelity,
    instrument,
    match,
    movements,
    movementsDeltaMinor,
    name,
    rowId,
    uncertain,
    valueMinor,
    ...(declaredCostMinor === undefined ? {} : { declaredCostMinor }),
    ...(securityId === undefined ? {} : { securityId }),
  };
}

export function parseReconcileProposal(raw: unknown): ReconcileProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "reconcile") return null;
  const draft = parseReconcileProposalDraft(raw.draft);
  const rows = parseAll(raw.rows, parseRow);
  const { netWorthBeforeMinor } = raw;
  if (draft === null || rows === null) return null;
  if (!isNullableNumber(netWorthBeforeMinor)) return null;
  return { draft, netWorthBeforeMinor, proposalType: "reconcile", rows };
}

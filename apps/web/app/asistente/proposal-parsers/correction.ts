/**
 * Trust boundary for a correction proposal (#1051/#1053) — the lane that also
 * carries a reconstruction and its amendment (#1423).
 *
 * `mode` closes the type: "solo-desde-hoy" is a small diff of declared facts,
 * "reconstruir" is a dated series with the three-witness verdict the card prints and
 * DEREFERENCES (#1422). A payload from before that verdict existed loses the card —
 * the draft is still there and the next turn rebuilds it — instead of throwing while
 * painting a figure it never carried.
 */

import type {
  CorrectionGuarantee,
  CorrectionPointOrigin,
} from "@web/asistente/anchor-correction-gate";
import type {
  CorrectionProposal,
  CorrectionProposalEditRow,
  CorrectionSeriesPoint,
} from "@web/asistente/correction-proposal-contract";
import { parseCorrectionProposalDraft } from "@web/asistente/correction-proposal-contract";
import {
  isNullableNumber,
  isOneOf,
  isOptionalBoolean,
  isOptionalString,
  isRecord,
  parseAll,
  parseBalanceCurvePoint,
  parseBalanceReconciliation,
  parseNamedRef,
  parseSnapshotMembership,
  vocabulary,
} from "./shapes";

const ORIGINS = vocabulary<CorrectionPointOrigin>({ assistant: true, user: true });

/**
 * The guarantee block the card renders (superficie C). Both reconciled and mismatch
 * PRINT their two figures, so a `{ state: "reconciled" }` with no figures is not a
 * weaker guarantee — it is an "undefined €" on screen.
 */
function parseGuarantee(raw: unknown): CorrectionGuarantee | null {
  if (!isRecord(raw)) return null;
  if (raw.state === "declared") return { state: "declared" };
  if (raw.state === "unverified") return { state: "unverified" };
  const { anchorMinor, resultingMinor } = raw;
  if (typeof anchorMinor !== "number") return null;
  if (raw.state === "reconciled") {
    if (typeof resultingMinor !== "number") return null;
    return { anchorMinor, resultingMinor, state: "reconciled" };
  }
  if (raw.state !== "mismatch") return null;
  if (!isNullableNumber(resultingMinor)) return null;
  return { anchorMinor, resultingMinor, state: "mismatch" };
}

function parseEditRow(raw: unknown): CorrectionProposalEditRow | null {
  if (!isRecord(raw)) return null;
  const { after, before, label, origin } = raw;
  if (typeof label !== "string" || typeof before !== "string") return null;
  if (typeof after !== "string" || !isOneOf(origin, ORIGINS)) return null;
  return { after, before, label, origin };
}

function parseSeriesPoint(raw: unknown): CorrectionSeriesPoint | null {
  if (!isRecord(raw)) return null;
  const { balanceMinor, date, driftMinor, excluded, origin, reason } = raw;
  if (typeof date !== "string" || !isNullableNumber(balanceMinor)) return null;
  if (!isOneOf(origin, ORIGINS)) return null;
  if (!isOptionalBoolean(excluded) || !isOptionalString(reason)) return null;
  if (!(driftMinor === undefined || isNullableNumber(driftMinor))) return null;
  return {
    balanceMinor,
    date,
    origin,
    ...(driftMinor === undefined ? {} : { driftMinor }),
    ...(excluded === undefined ? {} : { excluded }),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function parseCorrectionProposal(raw: unknown): CorrectionProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "correction") return null;
  const draft = parseCorrectionProposalDraft(raw.draft);
  const holding = parseNamedRef(raw.holding);
  const guarantee = parseGuarantee(raw.guarantee);
  const { folio, summary } = raw;
  if (draft === null || holding === null || guarantee === null) return null;
  if (typeof summary !== "string" || typeof folio !== "string") return null;
  const base = {
    draft,
    folio,
    guarantee,
    holding,
    proposalType: "correction" as const,
    summary,
  };

  if (raw.mode === "solo-desde-hoy") {
    const edits = parseAll(raw.edits, parseEditRow);
    return edits === null ? null : { ...base, edits, mode: "solo-desde-hoy" };
  }

  if (raw.mode !== "reconstruir") return null;
  const series = parseAll(raw.series, parseSeriesPoint);
  const curve = parseAll(raw.curve, parseBalanceCurvePoint);
  const reconciliation = parseBalanceReconciliation(raw.reconciliation);
  const membership = parseSnapshotMembership(raw.snapshotMembership);
  const { anchorMinor } = raw;
  if (series === null || curve === null || reconciliation === null) return null;
  if (membership === null || typeof anchorMinor !== "number") return null;
  return {
    ...base,
    anchorMinor,
    curve,
    mode: "reconstruir",
    reconciliation,
    series,
    snapshotMembership: membership,
  };
}

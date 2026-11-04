/**
 * What the «Coste del traspaso» panel asks (#1882, PRD #1876 S7), pure
 * (interaction-patterns §7): the entry whose inherited cost is pending, and — for an
 * internal traspaso — the reimbursement a rule by proximity proposes as its origin.
 *
 * The cost the proposal says would travel comes from `confirmTransferOrigin`, the
 * very function the write runs (#1438): the figure the panel promises is the figure
 * the book will hold.
 */

import { formatIsoDayEs } from "@web/asistente/iso-day-es";
import type { TransferRowCounterpart } from "@web/operation-kind-copy";
import {
  confirmTransferOrigin,
  formatUnits,
  type InvestmentOperation,
  multiplyToMinor,
  pendingInheritedCostEntries,
  proposeTransferOrigin,
} from "@worthline/domain";
import { isMyInvestorExternalEntry, isMyInvestorUnpairedLeg } from "@worthline/pricing";

export interface InheritedCostProposal {
  /** The reimbursement's row: what «Sí, vienen de ahí» confirms. */
  originId: string;
  holdingName: string;
  date: string;
  /** The cash the reimbursement moved. */
  amountMinor: number;
  /** The cost that would travel to this holding: the origin's average cost of it. */
  costMinor: number;
}

export interface InheritedCostView {
  /** The pending entry this panel answers: the earliest one. */
  entryId: string;
  date: string;
  units: string;
  /** What the units were worth the day they arrived — a value, never shown as a cost. */
  arrivedMinor: number;
  /** From another institution, or a traspaso inside the source with no pair. */
  origin: "external" | "internal";
  proposal: InheritedCostProposal | null;
  /** How many entries are pending: the panel answers one at a time. */
  pendingCount: number;
}

/** The entry the panel asks about: the earliest pending one, or null. */
export function pendingEntry(
  operations: readonly InvestmentOperation[],
): InvestmentOperation | null {
  return pendingInheritedCostEntries(operations)[0] ?? null;
}

/**
 * The reimbursement the rule proposes for the pending entry, or null. An entry from
 * another institution is never offered an origin inside the source.
 */
export function proposedOrigin(
  operations: readonly InvestmentOperation[],
  candidates: readonly InvestmentOperation[],
): InvestmentOperation | null {
  const entry = pendingEntry(operations);
  if (entry === null || isMyInvestorExternalEntry(entry.transferId)) return null;
  return proposeTransferOrigin(entry, candidates);
}

/**
 * The ledger's counterparts, with what is not known said as not known: a traspaso
 * leg the connector could not pair has no counterpart row, and reading that as
 * «desde otra entidad» would call a fund-to-fund move inside MyInvestor an entry
 * from outside. It claims nothing until the user confirms its origin (#1882).
 */
export function withUnknownOrigins(
  operations: readonly InvestmentOperation[],
  counterparts: Readonly<Record<string, TransferRowCounterpart>>,
): Record<string, TransferRowCounterpart> {
  const result = { ...counterparts };
  for (const operation of operations) {
    if (
      isMyInvestorUnpairedLeg(operation.transferId) &&
      result[operation.id]?.kind === "external"
    ) {
      result[operation.id] = { kind: "unresolved" };
    }
  }
  return result;
}

export function inheritedCostView(input: {
  /** This holding's ledger. */
  operations: readonly InvestmentOperation[];
  /** The source's unpaired outgoing legs (`readUnpairedOutLegs`). */
  candidates: readonly InvestmentOperation[];
  /** The proposed origin's whole ledger, read only when there is one. */
  originLedger: readonly InvestmentOperation[] | null;
  /** The live holdings' names: an origin that cannot be named is not proposed. */
  holdingNames: ReadonlyMap<string, string>;
}): InheritedCostView | null {
  const pending = pendingInheritedCostEntries(input.operations);
  const entry = pending[0];
  if (entry === undefined) return null;

  const origin = proposedOrigin(input.operations, input.candidates);
  const holdingName = origin ? input.holdingNames.get(origin.assetId) : undefined;
  const confirmed =
    origin && holdingName !== undefined && input.originLedger !== null
      ? confirmTransferOrigin({ entry, origin, originLedger: input.originLedger })
      : null;

  return {
    arrivedMinor: entry.transferCostMinor ?? 0,
    date: formatIsoDayEs(entry.executedAt.slice(0, 10)),
    entryId: entry.id,
    origin: isMyInvestorExternalEntry(entry.transferId) ? "external" : "internal",
    pendingCount: pending.length,
    proposal:
      origin && holdingName !== undefined && confirmed?.ok
        ? {
            amountMinor: multiplyToMinor(origin.units, origin.pricePerUnit),
            costMinor: confirmed.value.incoming.transferCostMinor ?? 0,
            date: formatIsoDayEs(origin.executedAt.slice(0, 10)),
            holdingName,
            originId: origin.id,
          }
        : null,
    units: formatUnits(entry.units),
  };
}

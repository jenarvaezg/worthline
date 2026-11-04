/**
 * The inherited cost a connector could not know (#1882, PRD #1876 S7; ADR 0115 as
 * amended 2026-11-04) — pure rules.
 *
 * A traspaso that enters a linked holding with no origin in the book arrives without
 * the cost its units carried. The connector writes it with a PROVISIONAL cost (the
 * value that arrived, so no gain is invented) and the `cost_pending` mark, and the
 * user answers it one of two ways:
 *
 * - **typing it**, from the old provider's papers: {@link answerInheritedCost};
 * - **confirming its origin**, when a rule by proximity finds the reimbursement
 *   that funded it ({@link proposeTransferOrigin}): {@link confirmTransferOrigin}
 *   turns both legs into ONE traspaso, so the reimbursement stops being a sale with a
 *   realized gain and its cost travels to the entry (ADR 0082). The rule only
 *   PROPOSES: nothing is ever paired without the user saying so.
 *
 * The cost that travels is `costLeavingOrigin`, the very fold the traspaso audit
 * careos every pair against, so a confirmed pair can never read as broken (#1422).
 */

import { daysBetween } from "./dates";
import { compareUnits, multiplyToMinor } from "./decimal";
import type { InvestmentOperation } from "./investment-types";
import { compareInvestmentOperations } from "./positions";
import { costLeavingOrigin } from "./transfer-pair-integrity";

/** How far back from the entry the origin may have left, its own day included. */
export const TRANSFER_ORIGIN_WINDOW_DAYS = 10;

/** How far the origin's amount may be from what arrived, in basis points (±5 %). */
export const TRANSFER_ORIGIN_TOLERANCE_BPS = 500;

/** Why an answer is refused. Words are the caller's: this is the rule. */
export type InheritedCostRefusal =
  /** The row is not an entry whose cost is pending — already answered, or not one. */
  | "not_pending"
  /** The typed cost is not a positive amount of cents. */
  | "cost_not_positive"
  /** The origin is not a reimbursement the rule would propose for this entry. */
  | "not_a_candidate"
  /** The origin charged a fee, and a `transfer_out` carries none (ADR 0082). */
  | "origin_has_fees";

export type InheritedCostResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: InheritedCostRefusal };

function isPending(operation: InvestmentOperation): boolean {
  return (
    operation.kind === "transfer_in" && operation.transferLegState === "cost_pending"
  );
}

/** The entries of a ledger whose inherited cost is still pending, in ledger order. */
export function pendingInheritedCostEntries(
  operations: readonly InvestmentOperation[],
): InvestmentOperation[] {
  return operations.filter(isPending).sort(compareInvestmentOperations);
}

/**
 * Whether any figure measured against this ledger's cost would rest on a cost
 * nobody gave: then the gain and the IRR are not shown as figures (#1882).
 */
export function hasPendingInheritedCost(
  operations: readonly InvestmentOperation[],
): boolean {
  return operations.some(isPending);
}

/** The cash the reimbursement moved: units × the price it executed at. */
function originAmountMinor(origin: InvestmentOperation): number {
  return multiplyToMinor(origin.units, origin.pricePerUnit);
}

/** The value that arrived: the provisional cost the pending entry carries. */
function arrivedMinor(entry: InvestmentOperation): number {
  return entry.transferCostMinor ?? 0;
}

/**
 * Whether `origin` is a reimbursement the rule would propose for `entry`: an
 * unpaired outgoing leg of another holding, in the same currency, that left in the
 * {@link TRANSFER_ORIGIN_WINDOW_DAYS} days up to the entry, for an amount within
 * {@link TRANSFER_ORIGIN_TOLERANCE_BPS} of what arrived.
 */
export function isTransferOriginFor(
  entry: InvestmentOperation,
  origin: InvestmentOperation,
): boolean {
  if (!isPending(entry)) return false;
  if (origin.kind !== "sell" || origin.transferLegState !== "unpaired_out") return false;
  if (origin.assetId === entry.assetId || origin.currency !== entry.currency) {
    return false;
  }
  const back = daysBetween(origin.executedAt.slice(0, 10), entry.executedAt.slice(0, 10));
  if (back < 0 || back > TRANSFER_ORIGIN_WINDOW_DAYS) return false;
  const arrived = arrivedMinor(entry);
  if (arrived <= 0) return false;
  const gap = Math.abs(originAmountMinor(origin) - arrived);
  return gap * 10_000 <= arrived * TRANSFER_ORIGIN_TOLERANCE_BPS;
}

/**
 * The reimbursement the rule PROPOSES as the origin of a pending entry, or null.
 * Of several that fit, the nearest amount wins, then the nearest day, then the id —
 * a stable answer, never a guess the user does not see: it is only proposed.
 */
export function proposeTransferOrigin(
  entry: InvestmentOperation,
  candidates: readonly InvestmentOperation[],
): InvestmentOperation | null {
  const arrived = arrivedMinor(entry);
  const day = entry.executedAt.slice(0, 10);
  const fits = candidates
    .filter((candidate) => isTransferOriginFor(entry, candidate))
    .map((candidate) => ({
      back: daysBetween(candidate.executedAt.slice(0, 10), day),
      candidate,
      gap: Math.abs(originAmountMinor(candidate) - arrived),
    }))
    .sort(
      (left, right) =>
        left.gap - right.gap ||
        left.back - right.back ||
        left.candidate.id.localeCompare(right.candidate.id),
    );
  return fits[0]?.candidate ?? null;
}

/**
 * The entry with the cost the user typed: the provisional one replaced, and the
 * mark saying who gave it. One row, so one ripple of one holding.
 */
export function answerInheritedCost(
  entry: InvestmentOperation,
  costMinor: number,
): InheritedCostResult<InvestmentOperation> {
  if (!isPending(entry)) return { ok: false, reason: "not_pending" };
  if (!Number.isSafeInteger(costMinor) || costMinor <= 0) {
    return { ok: false, reason: "cost_not_positive" };
  }
  return {
    ok: true,
    value: { ...entry, transferCostMinor: costMinor, transferLegState: "cost_declared" },
  };
}

/**
 * The two legs as ONE traspaso, once the user confirmed the proposed origin.
 *
 * - The reimbursement becomes the `transfer_out`: it stops realizing a gain, and the
 *   cost it removes from the origin is the same it removed as a sale (the average
 *   cost does not care which), so the origin's cost basis after it does not move.
 * - The entry inherits exactly that cost, `costLeavingOrigin` over the origin's
 *   ledger, and both share the entry's `transferId`.
 *
 * `originLedger` is the origin holding's whole ledger: only the rows before the
 * reimbursement are folded, by the fold's own comparator.
 */
export function confirmTransferOrigin(input: {
  entry: InvestmentOperation;
  origin: InvestmentOperation;
  originLedger: readonly InvestmentOperation[];
}): InheritedCostResult<{ out: InvestmentOperation; incoming: InvestmentOperation }> {
  const { entry, origin } = input;
  if (!isPending(entry)) return { ok: false, reason: "not_pending" };
  if (!isTransferOriginFor(entry, origin))
    return { ok: false, reason: "not_a_candidate" };
  if (origin.feesMinor !== 0) return { ok: false, reason: "origin_has_fees" };
  const transferId = entry.transferId;
  if (transferId === undefined || compareUnits(origin.units, "0") <= 0) {
    return { ok: false, reason: "not_a_candidate" };
  }

  const { transferLegState: _unpaired, ...sale } = origin;
  const out: InvestmentOperation = { ...sale, kind: "transfer_out", transferId };
  const costMinor = costLeavingOrigin(
    out,
    new Map([[origin.assetId, input.originLedger]]),
  );
  return {
    ok: true,
    value: {
      incoming: {
        ...entry,
        transferCostMinor: costMinor,
        transferId,
        transferLegState: "cost_from_origin",
      },
      out,
    },
  };
}

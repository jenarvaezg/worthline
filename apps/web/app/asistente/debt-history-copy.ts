/**
 * Copy the reconstruction / balance-history cards share for membership preflight
 * and the confirm result (#1438). Pure so the markup tests can assert the same
 * sentences the cards render, without reaching into the layer.
 */

import type { DebtRippleCounts } from "@worthline/db";
import {
  type DebtSnapshotMembership,
  debtMissingFromAllGeneratedMessage,
} from "@worthline/domain";

export function snapshotMembershipNotice(
  membership: DebtSnapshotMembership | undefined,
): { className: "assistantError" | "assistantWarning"; text: string } | null {
  if (membership === undefined) return null;
  if (membership.missing === membership.total && membership.total > 0) {
    return {
      className: "assistantError",
      text: debtMissingFromAllGeneratedMessage(membership.total),
    };
  }
  if (membership.missing > 0 && membership.missing < membership.total) {
    return {
      className: "assistantWarning",
      text: `${membership.missing} de ${membership.total} puntos no incluirán esta deuda (anteriores al inicio). El resto sí.`,
    };
  }
  return null;
}

/** Confirm stays off when none of the generate dates would carry the debt. */
export function snapshotMembershipAllowsConfirm(
  membership: DebtSnapshotMembership | undefined,
): boolean {
  if (membership === undefined) return true;
  return !(membership.missing === membership.total && membership.total > 0);
}

export function historyReconstructedCopy(counts: DebtRippleCounts): {
  className: "assistantOk" | "assistantWarning";
  text: string;
} {
  const captured = counts.generated + counts.recalculated;
  const omitted = counts.generated - counts.generatedWithLiability;
  if (omitted > 0) {
    return {
      className: "assistantWarning",
      text: `Historia reconstruida · ${captured} capturas, ${omitted} sin la deuda.`,
    };
  }
  return {
    className: "assistantOk",
    text: `Historia reconstruida · ${captured} capturas.`,
  };
}

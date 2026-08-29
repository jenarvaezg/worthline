/**
 * A holding sitting in the Papelera with units still on its ledger (#1365).
 */

import {
  type DataQualityCollector,
  type DataQualitySignal,
  signalNaturalKey,
} from "./data-quality-collector";
import { type DecimalString, formatUnits } from "./decimal";
import type { TrashExit } from "./holding-trash-exit";
import { unitsReadAsClosed } from "./warnings";

/** Machine code for a trashed holding whose position still holds units (#1365). */
export const TRASHED_WITH_BALANCE_CODE = "TRASHED_WITH_BALANCE";

/**
 * A soft-deleted holding as the health engine sees it (#1365). Carries only what
 * the trashed-balance rule needs: who it is, and which members own a share of it —
 * the trash is outside every live read, so its scope relevance is decided by
 * ownership intersection exactly as the trash listing decides it (#342), not by
 * the portfolio projection (which, by definition, cannot see it).
 */
export interface DataQualityTrashedHolding {
  id: string;
  name: string;
  ownerMemberIds: readonly string[];
  /**
   * How the holding left the book, when the Papelera's door recorded it (#1549).
   * `mis_entry` is the one exit this rule reads: it is the owner saying the value
   * was never real, which is precisely the question the signal asks. Absent on a
   * row archived before the door existed — and those keep raising it, honestly.
   */
  trashExit?: TrashExit | null;
}

export interface DataQualityTrashedBalanceInput {
  /**
   * The workspace's soft-deleted holdings (#1365). Required — not optional — for
   * the same reason `netUnitsByAssetId` is: a signal about the trash that only
   * one of the two consumers feeds is a signal the agent and the human disagree
   * about. An empty array is the honest reading of "nothing in the trash".
   */
  trashedHoldings: readonly DataQualityTrashedHolding[];
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>;
}

/**
 * Its value left the patrimonio at the capture after the delete, and the histórico
 * records no sale, no traspaso, and no deposit into any account. The money looks
 * evaporated — indistinguishable from the shape of someone who sold the fund and
 * then deleted it "porque ya no lo tengo" without recording the sale first.
 *
 * `high`, because unlike a stale price this is not a figure that MIGHT be wrong:
 * the drop already happened. Both repairs already exist on the trash listing and
 * both clear this signal by removing its cause — restore it and record the sale,
 * or hard-delete to confirm the borrado — so it needs no acknowledgement door of
 * its own (and, unlike an overrideable warning, a trashed holding has no ficha to
 * acknowledge it from).
 *
 * Positive evidence only: the holding must HAVE an entry in the net-units map and
 * that entry must not read as closed. A holding absent from the map — a cash
 * account, a flat, anything without an operations ledger — says nothing about
 * units and is silent here, rather than being flagged on a rule it cannot answer.
 *
 * «Sin venta ni traspaso» is literal (#1481): a ledger emptied by a `transfer_out`
 * folds to zero net units, so a holding that LEFT by traspaso never reaches this
 * signal — the same legitimate exit a sale is.
 *
 * The third exit is silent for a different reason (#1549): «fue un error de
 * registro» is the owner declaring that the value was never real. The units are
 * still on the ledger — restoring the holding must bring it back as it was — so only
 * the declaration itself can distinguish this from the silence the rule hunts. A
 * signal that survived being answered would be a signal nobody can ever clear.
 */
export const collectTrashedBalanceSignals: DataQualityCollector<
  DataQualityTrashedBalanceInput
> = (input) => {
  const signals: DataQualitySignal[] = [];

  for (const holding of input.trashedHoldings) {
    if (!holding.ownerMemberIds.some((memberId) => input.scopeMemberIds.has(memberId))) {
      continue;
    }

    if (holding.trashExit === "mis_entry") {
      continue;
    }

    const units = input.netUnitsByAssetId.get(holding.id);
    if (units === undefined || unitsReadAsClosed(units)) {
      continue;
    }

    signals.push({
      affected: { id: holding.id, label: holding.name, object: "holding" },
      category: "trashed_balance",
      code: TRASHED_WITH_BALANCE_CODE,
      fixable: true,
      label:
        `"${holding.name}" está en la Papelera con ${formatUnits(units)} unidades: su valor salió ` +
        "de tu patrimonio sin venta ni traspaso. Recupéralo y registra la venta, o confirma el borrado.",
      naturalKey: signalNaturalKey(
        "trashed_balance",
        TRASHED_WITH_BALANCE_CODE,
        holding.id,
      ),
      severity: "high",
    });
  }

  return signals;
};

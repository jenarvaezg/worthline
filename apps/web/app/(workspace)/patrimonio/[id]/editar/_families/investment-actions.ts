/**
 * The investment ficha's server actions, bound to the holding they belong to.
 *
 * The ficha is the single place an operation is recorded (#153 collapsed the
 * /inversiones management routes), and since #1606 the actions themselves live
 * one module per surface. What was left over was the BINDING — ten little
 * closures tying each of those actions to this holding's id — and it had settled
 * in the middle of the family module, where it changed for a reason of its own:
 * a new surface's action, never a change to how the family renders.
 *
 * So it lives here. `bindInvestmentActions` is the whole seam: the family calls
 * it once and hands each section the action it posts to.
 */

import {
  deleteOperationAction,
  recordOperationAction,
} from "@web/inversiones/operation-actions";
import {
  confirmPriceBackfillAction,
  type PriceBackfillPreviewState,
  previewPriceBackfillAction,
} from "@web/inversiones/price-backfill-actions";
import {
  confirmSnapshotPriceCorrectionAction,
  previewSnapshotPriceCorrectionAction,
  type SnapshotPriceCorrectionPreviewState,
} from "@web/inversiones/snapshot-price-correction-actions";
import {
  confirmStatementAction,
  previewStatementAction,
  type StatementPreviewState,
} from "@web/inversiones/statement-actions";
import { recordTransferAction } from "@web/inversiones/transfer-action";

/** Every action an investment ficha's surfaces post to, already bound. */
export function bindInvestmentActions(assetId: string) {
  async function recordOperation(formData: FormData) {
    "use server";
    // Returns the rejection instead of swallowing it (#1311): success still
    // redirects, so the only thing that comes back here is a refusal the editor
    // renders in its own error band.
    return recordOperationAction(assetId, formData);
  }

  async function deleteOperation(formData: FormData) {
    "use server";
    await deleteOperationAction(assetId, formData);
  }

  async function recordTransfer(formData: FormData) {
    "use server";
    await recordTransferAction(assetId, formData);
  }

  async function previewStatement(prev: StatementPreviewState, formData: FormData) {
    "use server";
    return previewStatementAction(assetId, prev, formData);
  }

  async function confirmStatement(formData: FormData) {
    "use server";
    await confirmStatementAction(assetId, formData);
  }

  async function previewPriceBackfill(
    prev: PriceBackfillPreviewState,
    formData: FormData,
  ) {
    "use server";
    return previewPriceBackfillAction(assetId, prev, formData);
  }

  async function confirmPriceBackfill(formData: FormData) {
    "use server";
    await confirmPriceBackfillAction(assetId, formData);
  }

  async function previewSnapshotPriceCorrection(
    prev: SnapshotPriceCorrectionPreviewState,
    formData: FormData,
  ) {
    "use server";
    return previewSnapshotPriceCorrectionAction(assetId, prev, formData);
  }

  async function confirmSnapshotPriceCorrection(formData: FormData) {
    "use server";
    await confirmSnapshotPriceCorrectionAction(assetId, formData);
  }

  return {
    confirmPriceBackfill,
    confirmSnapshotPriceCorrection,
    confirmStatement,
    deleteOperation,
    previewPriceBackfill,
    previewSnapshotPriceCorrection,
    previewStatement,
    recordOperation,
    recordTransfer,
  };
}

/**
 * Pure assembly for the traspaso row notes (#1481): joins one ledger's operations
 * with the store's counterpart map and the workspace's holding names, so the
 * operations table can print each half as one move with an origin and a
 * destination. Server-side data shaping — the component only renders the result.
 */

import type { TransferRowCounterpart } from "@web/operation-kind-copy";
import type { InvestmentOperation } from "@worthline/domain";
import { isTransferKind } from "@worthline/domain";

/**
 * One entry per traspaso half on the ledger, keyed by operation id:
 *  - a counterpart row whose holding has a name → `holding` (printable);
 *  - no counterpart row anywhere → `external` (the real half-pair of #1393:
 *    a plan brought in from another entity);
 *  - a counterpart row whose holding cannot be named (Papelera) → `unresolved`,
 *    which claims nothing rather than mislabelling it as external.
 */
export function transferCounterpartByOperationId(
  operations: readonly InvestmentOperation[],
  counterpartByTransferId: ReadonlyMap<string, { assetId: string }>,
  assetNameById: ReadonlyMap<string, string>,
): Record<string, TransferRowCounterpart> {
  const result: Record<string, TransferRowCounterpart> = {};

  for (const operation of operations) {
    if (!isTransferKind(operation.kind)) continue;

    const counterpart =
      operation.transferId !== undefined
        ? counterpartByTransferId.get(operation.transferId)
        : undefined;
    if (counterpart === undefined) {
      result[operation.id] = { kind: "external" };
      continue;
    }

    const name = assetNameById.get(counterpart.assetId);
    result[operation.id] =
      name !== undefined ? { kind: "holding", name } : { kind: "unresolved" };
  }

  return result;
}

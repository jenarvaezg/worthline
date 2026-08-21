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
 * One entry per traspaso half on the ledger, keyed by operation id. The three
 * outcomes and what each may claim are defined on {@link TransferRowCounterpart}
 * — this function only decides which one the joined data supports: a named
 * holding, no counterpart row at all (`external`), or a row whose holding is
 * missing from the name map (`unresolved`, e.g. the Papelera).
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

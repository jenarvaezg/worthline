/**
 * The traspasos already written that no longer read as a whole pair (#1519).
 *
 * The rule and its wording live in `transfer-pair-integrity`; this family only
 * decides which pairs are asked and dresses the answer as a signal.
 */

import {
  type DataQualityCollector,
  type DataQualityScopeContext,
  signalNaturalKey,
} from "./data-quality-collector";
import type { InvestmentOperation } from "./investment-types";
import {
  auditTransferPairs,
  describeBrokenTransferPairs,
} from "./transfer-pair-integrity";
import type { Workspace } from "./workspace-types";

/** Machine code for a traspaso the book can no longer read as a whole pair (#1519). */
export const TRANSFER_PAIR_BROKEN_CODE = "TRANSFER_PAIR_BROKEN";

export interface DataQualityTransferIntegrityInput {
  scope: DataQualityScopeContext;
  workspace: Workspace;
  /**
   * The whole investment ledger, keyed by holding — the same map the
   * savings-coherence watch reads, so this family costs no extra I/O.
   *
   * It has to be the WORKSPACE's, not the scope's: the audit reads a missing leg
   * as evidence of a broken pair, and a narrowed map would invent orphans. The
   * scope decides which pairs are reported, not which rows are counted.
   */
  investmentOperationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>;
}

/**
 * ONE signal per scope carrying every broken pair, never one per pair — the
 * aggregation rule of #654, for the same reason #1356 folds 77 unvalued coins into
 * one line: the panel is read to decide what to go and fix, and twenty identical
 * lines bury everything else.
 *
 * `high`, and not overrideable: this is not a figure the user typed that might be
 * right after all, it is the book contradicting itself — the same engine compared
 * against itself, at zero tolerance (#1422). Nothing on the patrimonio screen
 * moves (a traspaso changes cost basis, not market value), so the hero filters it
 * out; the consumer is whoever maintains the data, which is where a broken pair
 * gets repaired.
 */
export const collectTransferIntegritySignals: DataQualityCollector<
  DataQualityTransferIntegrityInput
> = (input) => {
  const broken = auditTransferPairs({
    holdingIds: input.ownedAssetIds,
    operationsByAssetId: input.investmentOperationsByAssetId,
  });

  if (broken.length === 0) {
    return [];
  }

  return [
    {
      affected: {
        id: input.scope.internalScopeId,
        label: input.scope.scopeLabel,
        object: "scope",
      },
      category: "transfer_integrity",
      code: TRANSFER_PAIR_BROKEN_CODE,
      // There is no form that repairs a half-written pair: the fix is a write to
      // the ledger, so the signal reports and does not pretend to link anywhere.
      fixable: false,
      // The base currency, never the operation's own: the ledger is STORED in the
      // base currency and a non-euro apunte keeps its statement figures in
      // `capture` (#1401), so an inherited cost — a fold-derived figure — only
      // ever exists in euros. Same rule, and the same reason, as the ficha's
      // `transferRowNote`.
      label: describeBrokenTransferPairs(broken, input.workspace.baseCurrency),
      naturalKey: signalNaturalKey(
        "transfer_integrity",
        TRANSFER_PAIR_BROKEN_CODE,
        input.scope.internalScopeId,
      ),
      severity: "high",
    },
  ];
};

import type { FactPersistenceProvenance } from "@db/fact-provenance";
import type { AddBalanceRebaselineInput } from "@db/liability-store";

import { applyDatedFactsBatch } from "./apply-dated-facts-batch";
import type {
  CommandResult,
  DebtRippleCounts,
  FactBatchInput,
  FactBatchTrigger,
  RipplePlan,
  UnitOfWork,
} from "./types";
import { EMPTY_DEBT_RIPPLE_COUNTS } from "./types";

export interface ImportBalanceHistoryCommand {
  liabilityId: string;
  rebaselines: AddBalanceRebaselineInput[];
  today: string;
  /** User-facing ingestion origin; assistant execution overrides this internally. */
  trigger?: Extract<FactBatchTrigger, "manual" | "csv">;
}

export interface ImportBalanceHistoryResult {
  created: number;
  ripple: RipplePlan | null;
  snapshots: DebtRippleCounts;
}

/** Private persistence/ripple capabilities required by this command executor. */
export interface ImportBalanceHistoryDependencies {
  addBalanceRebaselines: (
    inputs: readonly AddBalanceRebaselineInput[],
    provenance: FactPersistenceProvenance,
  ) => Promise<void>;
  rippleDebtRebaseline: (params: {
    liabilityId: string;
    fromDateKey: string;
    today: string;
  }) => Promise<DebtRippleCounts>;
  uow: UnitOfWork;
}

/**
 * Import a balance-history series as a chain of re-baselines (ADR 0056, #696,
 * architecture review #969). One mutation = one transaction + one ripple from
 * the oldest checkpoint via `ApplyDatedFactsBatch`.
 */
export async function executeImportBalanceHistoryCommand(
  dependencies: ImportBalanceHistoryDependencies,
  command: ImportBalanceHistoryCommand,
  batch: FactBatchInput = { trigger: command.trigger ?? "manual" },
): Promise<CommandResult<ImportBalanceHistoryResult>> {
  const { today } = command;
  let snapshots: DebtRippleCounts = EMPTY_DEBT_RIPPLE_COUNTS;

  const result = await applyDatedFactsBatch(dependencies.uow, {
    batch,
    ripple: async (fromDateKey) => {
      snapshots = await dependencies.rippleDebtRebaseline({
        fromDateKey,
        liabilityId: command.liabilityId,
        today,
      });
    },
    // ONE step for the whole chain (#1435): the checkpoints go in batched instead
    // of one round-trip each, and every baseline date still reaches the ripple
    // floor, so it starts at the oldest checkpoint exactly as before.
    steps: [
      {
        persist: async (batchId) => {
          await dependencies.addBalanceRebaselines(command.rebaselines, { batchId });
          return command.rebaselines.map((rebaseline) => rebaseline.baselineDate);
        },
      },
    ],
    today,
  });

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    value: {
      created: command.rebaselines.length,
      ripple: result.value,
      snapshots,
    },
  };
}

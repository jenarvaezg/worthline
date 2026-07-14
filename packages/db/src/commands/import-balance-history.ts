import type { FactPersistenceProvenance } from "@db/fact-provenance";
import type { AddBalanceRebaselineInput } from "@db/liability-store";

import { applyDatedFactsBatch } from "./apply-dated-facts-batch";
import type {
  CommandResult,
  FactBatchInput,
  FactBatchTrigger,
  RipplePlan,
  UnitOfWork,
} from "./types";

export interface ImportBalanceHistoryCommand {
  liabilityId: string;
  rebaselines: AddBalanceRebaselineInput[];
  today?: string;
  /** User-facing ingestion origin; assistant execution overrides this internally. */
  trigger?: Extract<FactBatchTrigger, "manual" | "csv">;
}

export interface ImportBalanceHistoryResult {
  created: number;
  ripple: RipplePlan | null;
}

/** Private persistence/ripple capabilities required by this command executor. */
export interface ImportBalanceHistoryDependencies {
  addBalanceRebaseline: (
    input: AddBalanceRebaselineInput,
    provenance: FactPersistenceProvenance,
  ) => Promise<void>;
  rippleDebtRebaseline: (params: {
    liabilityId: string;
    fromDateKey: string;
    today: string;
  }) => Promise<void>;
  uow: UnitOfWork;
}

function defaultToday(today?: string): string {
  return today ?? new Date().toISOString().slice(0, 10);
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
  const today = defaultToday(command.today);

  const result = await applyDatedFactsBatch(dependencies.uow, {
    batch,
    ripple: async (fromDateKey) => {
      await dependencies.rippleDebtRebaseline({
        fromDateKey,
        liabilityId: command.liabilityId,
        today,
      });
    },
    steps: command.rebaselines.map((rebaseline) => ({
      persist: async (batchId) => {
        await dependencies.addBalanceRebaseline(rebaseline, { batchId });
        return rebaseline.baselineDate;
      },
    })),
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
    },
  };
}

import type { AddBalanceRebaselineInput } from "@db/liability-store";
import type { WorthlineStore } from "@db/store-types";

import { applyDatedFactsBatch } from "./apply-dated-facts-batch";
import type { CommandResult, RipplePlan } from "./types";

export interface ImportBalanceHistoryCommand {
  liabilityId: string;
  rebaselines: AddBalanceRebaselineInput[];
  today?: string;
}

export interface ImportBalanceHistoryResult {
  created: number;
  ripple: RipplePlan | null;
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
  store: WorthlineStore,
  command: ImportBalanceHistoryCommand,
): Promise<CommandResult<ImportBalanceHistoryResult>> {
  if (command.rebaselines.length === 0) {
    return { ok: true, value: { created: 0, ripple: null } };
  }

  const today = defaultToday(command.today);
  const { rippleDebtRebaseline, uow } = store.command;

  const result = await applyDatedFactsBatch(uow, {
    ripple: async (fromDateKey) => {
      await rippleDebtRebaseline({
        fromDateKey,
        liabilityId: command.liabilityId,
        today,
      });
    },
    steps: command.rebaselines.map((rebaseline) => ({
      persist: async () => {
        await store.liabilities.addBalanceRebaseline(rebaseline);
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

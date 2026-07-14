import type { UpdateInvestmentOperationInput } from "@db/operations-store";
import type { WorthlineStore } from "@db/store-types";
import type { CreateInvestmentOperationInput } from "@worthline/domain";

import type { CommandResult } from "./types";

// ── Command inputs ────────────────────────────────────────────────────────────

export interface RecordInvestmentOperationCommand {
  operation: CreateInvestmentOperationInput;
  today?: string;
}

export interface DeleteInvestmentOperationCommand {
  operationId: string;
  today?: string;
}

export interface MergeStatementOperationsCommand {
  assetId: string;
  creates: CreateInvestmentOperationInput[];
  overwrites: UpdateInvestmentOperationInput[];
  deletes?: string[];
  today?: string;
}

export interface DeleteInvestmentOperationResult {
  assetId: string;
  executedAt: string;
}

// ── Executors ───────────────────────────────────────────────────────────────

function defaultToday(today?: string): string {
  return today ?? new Date().toISOString().slice(0, 10);
}

export async function executeRecordInvestmentOperationCommand(
  store: WorthlineStore,
  command: RecordInvestmentOperationCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  await store.command.recordInvestmentOperation(command.operation, { today });
  return { ok: true, value: undefined };
}

export async function executeDeleteInvestmentOperationCommand(
  store: WorthlineStore,
  command: DeleteInvestmentOperationCommand,
): Promise<CommandResult<DeleteInvestmentOperationResult | null>> {
  const today = defaultToday(command.today);
  const deleted = await store.command.deleteInvestmentOperation({
    operationId: command.operationId,
    today,
  });
  return { ok: true, value: deleted };
}

export async function executeMergeStatementOperationsCommand(
  store: WorthlineStore,
  command: MergeStatementOperationsCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  const params: Parameters<WorthlineStore["command"]["mergeInvestmentOperations"]>[0] = {
    assetId: command.assetId,
    creates: command.creates,
    overwrites: command.overwrites,
    today,
  };
  if (command.deletes !== undefined) {
    params.deletes = command.deletes;
  }
  await store.command.mergeInvestmentOperations(params);
  return { ok: true, value: undefined };
}

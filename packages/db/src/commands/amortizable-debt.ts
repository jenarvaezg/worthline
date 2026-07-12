import type {
  AddBalanceRebaselineInput,
  AddEarlyRepaymentInput,
  AddInterestRateRevisionInput,
  CreateAmortizationPlanInput,
  UpdateAmortizationPlanInput,
  UpdateEarlyRepaymentInput,
  UpdateInterestRateRevisionInput,
} from "@db/liability-store";
import type { WorthlineStore } from "@db/store-types";

import type { CommandResult } from "./types";

// ── Command inputs ────────────────────────────────────────────────────────────

export interface CreateAmortizationPlanCommand {
  input: CreateAmortizationPlanInput;
  today?: string;
}

export interface UpdateAmortizationPlanCommand {
  planId: string;
  input: UpdateAmortizationPlanInput;
  liabilityId: string;
  today?: string;
}

export interface DeleteAmortizationPlanCommand {
  liabilityId: string;
  today?: string;
}

export interface AddInterestRateRevisionCommand {
  input: AddInterestRateRevisionInput;
  liabilityId: string;
  today?: string;
}

export interface UpdateInterestRateRevisionCommand {
  revisionId: string;
  input: UpdateInterestRateRevisionInput;
  today?: string;
}

export interface DeleteInterestRateRevisionCommand {
  revisionId: string;
  today?: string;
}

export interface AddEarlyRepaymentCommand {
  input: AddEarlyRepaymentInput;
  liabilityId: string;
  today?: string;
}

export interface UpdateEarlyRepaymentCommand {
  repaymentId: string;
  input: UpdateEarlyRepaymentInput;
  today?: string;
}

export interface DeleteEarlyRepaymentCommand {
  repaymentId: string;
  today?: string;
}

export interface CreateCurrentStateDebtCommand {
  plan: CreateAmortizationPlanInput;
  rebaseline: AddBalanceRebaselineInput;
  today?: string;
}

export interface RecalibrateDebtBalanceCommand {
  input: AddBalanceRebaselineInput;
  today?: string;
}

// ── Executors ───────────────────────────────────────────────────────────────

function defaultToday(today?: string): string {
  return today ?? new Date().toISOString().slice(0, 10);
}

export async function executeCreateAmortizationPlanCommand(
  store: WorthlineStore,
  command: CreateAmortizationPlanCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  await store.createAmortizationPlanAndRipple(command.input, { today });
  return { ok: true, value: undefined };
}

export async function executeUpdateAmortizationPlanCommand(
  store: WorthlineStore,
  command: UpdateAmortizationPlanCommand,
): Promise<CommandResult<{ changes: number }>> {
  const today = defaultToday(command.today);
  const changes = await store.updateAmortizationPlanAndRipple(
    command.planId,
    command.input,
    { liabilityId: command.liabilityId, today },
  );
  return { ok: true, value: { changes } };
}

export async function executeDeleteAmortizationPlanCommand(
  store: WorthlineStore,
  command: DeleteAmortizationPlanCommand,
): Promise<CommandResult<{ changes: number }>> {
  const today = defaultToday(command.today);
  const changes = await store.deleteAmortizationPlanAndRipple({
    liabilityId: command.liabilityId,
    today,
  });
  return { ok: true, value: { changes } };
}

export async function executeAddInterestRateRevisionCommand(
  store: WorthlineStore,
  command: AddInterestRateRevisionCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  await store.addInterestRateRevisionAndRipple(command.input, {
    liabilityId: command.liabilityId,
    today,
  });
  return { ok: true, value: undefined };
}

export async function executeUpdateInterestRateRevisionCommand(
  store: WorthlineStore,
  command: UpdateInterestRateRevisionCommand,
): Promise<CommandResult<{ changes: number }>> {
  const today = defaultToday(command.today);
  const changes = await store.updateInterestRateRevisionAndRipple(
    command.revisionId,
    command.input,
    { today },
  );
  return { ok: true, value: { changes } };
}

export async function executeDeleteInterestRateRevisionCommand(
  store: WorthlineStore,
  command: DeleteInterestRateRevisionCommand,
): Promise<CommandResult<{ changes: number }>> {
  const today = defaultToday(command.today);
  const changes = await store.deleteInterestRateRevisionAndRipple(command.revisionId, {
    today,
  });
  return { ok: true, value: { changes } };
}

export async function executeAddEarlyRepaymentCommand(
  store: WorthlineStore,
  command: AddEarlyRepaymentCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  await store.addEarlyRepaymentAndRipple(command.input, {
    liabilityId: command.liabilityId,
    today,
  });
  return { ok: true, value: undefined };
}

export async function executeUpdateEarlyRepaymentCommand(
  store: WorthlineStore,
  command: UpdateEarlyRepaymentCommand,
): Promise<CommandResult<{ changes: number }>> {
  const today = defaultToday(command.today);
  const changes = await store.updateEarlyRepaymentAndRipple(
    command.repaymentId,
    command.input,
    { today },
  );
  return { ok: true, value: { changes } };
}

export async function executeDeleteEarlyRepaymentCommand(
  store: WorthlineStore,
  command: DeleteEarlyRepaymentCommand,
): Promise<CommandResult<{ changes: number }>> {
  const today = defaultToday(command.today);
  const changes = await store.deleteEarlyRepaymentAndRipple(command.repaymentId, {
    today,
  });
  return { ok: true, value: { changes } };
}

export async function executeCreateCurrentStateDebtCommand(
  store: WorthlineStore,
  command: CreateCurrentStateDebtCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  await store.createCurrentStateDebtAndRipple({
    plan: command.plan,
    rebaseline: command.rebaseline,
    today,
  });
  return { ok: true, value: undefined };
}

export async function executeRecalibrateDebtBalanceCommand(
  store: WorthlineStore,
  command: RecalibrateDebtBalanceCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  await store.addBalanceRebaselineAndRipple(command.input, { today });
  return { ok: true, value: undefined };
}

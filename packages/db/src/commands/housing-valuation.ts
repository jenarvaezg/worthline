import type {
  AddValuationAnchorInput,
  UpdateValuationAnchorInput,
} from "@db/asset-store";
import type { WorthlineStore } from "@db/store-types";
import type { DecimalString, ValuationCadence } from "@worthline/domain";
import type { CommandResult } from "./types";

// ── Command inputs ────────────────────────────────────────────────────────────

export interface AddValuationAnchorCommand {
  input: AddValuationAnchorInput;
  today?: string;
}

export interface UpdateValuationAnchorCommand {
  anchorId: string;
  input: UpdateValuationAnchorInput;
  today?: string;
}

export interface DeleteValuationAnchorCommand {
  anchorId: string;
  today?: string;
}

export interface SetAnnualAppreciationRateCommand {
  assetId: string;
  rate: DecimalString | null;
  today?: string;
}

export interface SetHousingValuationCadenceCommand {
  assetId: string;
  cadence: ValuationCadence | null;
  today?: string;
}

export interface RecordHousingValuationCommand {
  assetId: string;
  currentValueMinor: number;
  today?: string;
}

// ── Executors ───────────────────────────────────────────────────────────────

function defaultToday(today?: string): string {
  return today ?? new Date().toISOString().slice(0, 10);
}

export async function executeAddValuationAnchorCommand(
  store: WorthlineStore,
  command: AddValuationAnchorCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  await store.command.addValuationAnchor(command.input, { today });
  return { ok: true, value: undefined };
}

export async function executeUpdateValuationAnchorCommand(
  store: WorthlineStore,
  command: UpdateValuationAnchorCommand,
): Promise<CommandResult<{ changes: number }>> {
  const today = defaultToday(command.today);
  const changes = await store.command.updateValuationAnchor(
    command.anchorId,
    command.input,
    { today },
  );
  return { ok: true, value: { changes } };
}

export async function executeDeleteValuationAnchorCommand(
  store: WorthlineStore,
  command: DeleteValuationAnchorCommand,
): Promise<CommandResult<{ changes: number }>> {
  const today = defaultToday(command.today);
  const changes = await store.command.deleteValuationAnchor(command.anchorId, {
    today,
  });
  return { ok: true, value: { changes } };
}

export async function executeSetAnnualAppreciationRateCommand(
  store: WorthlineStore,
  command: SetAnnualAppreciationRateCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  await store.command.setAnnualAppreciationRate(command.assetId, command.rate, {
    today,
  });
  return { ok: true, value: undefined };
}

export async function executeSetHousingValuationCadenceCommand(
  store: WorthlineStore,
  command: SetHousingValuationCadenceCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  await store.command.setHousingValuationCadence(command.assetId, command.cadence, {
    today,
  });
  return { ok: true, value: undefined };
}

export async function executeRecordHousingValuationCommand(
  store: WorthlineStore,
  command: RecordHousingValuationCommand,
): Promise<CommandResult<void>> {
  const today = defaultToday(command.today);
  await store.command.recordHousingValuation(command.assetId, command.currentValueMinor, {
    today,
  });
  return { ok: true, value: undefined };
}

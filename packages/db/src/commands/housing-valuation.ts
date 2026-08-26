import type {
  AddValuationAnchorInput,
  UpdateValuationAnchorInput,
} from "@db/asset-store";
import type { WorthlineStore } from "@db/store-types";
import type {
  AcquisitionAnchorFields,
  AcquisitionEditPreview,
  DecimalString,
  ValuationCadence,
} from "@worthline/domain";
import { buildAcquisitionEditPreview } from "@worthline/domain";
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

export interface PreviewAcquisitionAnchorEditCommand {
  anchorId: string;
  input: AcquisitionAnchorFields;
  today?: string;
}

/**
 * What editing the acquisition anchor would do, in one answer: the two curves
 * (#1562) and how much history the rewrite touches, counted by the band that
 * does the writing.
 */
export interface AcquisitionAnchorEditPreview extends AcquisitionEditPreview {
  /** Existing snapshots the rewrite would re-derive. */
  snapshotsRecalculated: number;
  /** Snapshots the rewrite would mint at the from-date (0 or 1). */
  snapshotsGenerated: number;
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
  // #1437/#1562: the acquisition is the price paid on a date — the TOTAL truth
  // that anchors the curve, never an increment layered on top of it. The named
  // editor has no "es una tasación de mercado" checkbox to post, and the chat
  // writes through this same seam (never through the web form), so the invariant
  // is enforced HERE: demoting it to an improvement would add the purchase price
  // on top of the curve instead of anchoring it.
  const anchor = await store.assets.readValuationAnchorById(command.anchorId);
  const input: UpdateValuationAnchorInput =
    anchor?.kind === "acquisition"
      ? { ...command.input, adjustsPriorCurve: true }
      : command.input;
  const changes = await store.command.updateValuationAnchor(command.anchorId, input, {
    today,
  });
  return { ok: true, value: { changes } };
}

/**
 * Dry run of the acquisition edit (#1562): the curve before and after, and the
 * size of the rewrite, WITHOUT writing anything.
 *
 * Reserved for the acquisition anchor. Editing a recent appraisal moves the
 * stretch around one date and needs no ceremony; the acquisition starts the
 * whole history, so moving it redraws every day up to the next appraisal — 22
 * years of interpolated curve in the measured case, plus a re-ripple of every
 * snapshot since. Both figures come from the engines that do the work: the curve
 * from `valueHousingAtDate`, the counts from the ripple band itself (#1438).
 */
export async function executePreviewAcquisitionAnchorEditCommand(
  store: WorthlineStore,
  command: PreviewAcquisitionAnchorEditCommand,
): Promise<CommandResult<AcquisitionAnchorEditPreview>> {
  const today = defaultToday(command.today);
  const anchor = await store.assets.readValuationAnchorById(command.anchorId);
  if (!anchor) {
    return {
      ok: false,
      error: "No se encontró la adquisición — puede que ya se haya eliminado.",
    };
  }
  if (anchor.kind !== "acquisition") {
    return {
      ok: false,
      error: "Esta previsualización es solo para el ancla de adquisición.",
    };
  }

  const asset = (await store.assets.readAssets()).find((a) => a.id === anchor.assetId);
  if (!asset) {
    return { ok: false, error: "No se encontró el inmueble de esta adquisición." };
  }

  const [anchors, annualAppreciationRate, cadence] = await Promise.all([
    store.assets.readValuationAnchors(anchor.assetId),
    store.assets.readAnnualAppreciationRate(anchor.assetId),
    store.assets.readValuationCadence(anchor.assetId),
  ]);

  const otherAnchors = anchors
    .filter((a) => a.id !== anchor.id)
    .map(({ adjustsPriorCurve, valuationDate, valueMinor }) => ({
      adjustsPriorCurve,
      valuationDate,
      valueMinor,
    }));

  const preview = buildAcquisitionEditPreview({
    annualAppreciationRate,
    cadence,
    current: { valuationDate: anchor.valuationDate, valueMinor: anchor.valueMinor },
    currentValueMinor: asset.currentValue.amountMinor,
    edited: command.input,
    otherAnchors,
    today,
  });

  // The count is asked of the EDITED curve: whether the rewrite mints a snapshot
  // at the new from-date depends on the acquisition being there (a property has no
  // history before its first appraisal), so counting against the stored anchors
  // would under-report exactly the case this door exists for.
  const counts = await store.command.countValuationRippleSnapshots({
    anchors: [...otherAnchors, { adjustsPriorCurve: true, ...command.input }],
    assetId: anchor.assetId,
    fromDateKey: preview.fromDateKey,
    today,
  });

  return {
    ok: true,
    value: {
      ...preview,
      snapshotsGenerated: counts.generated,
      snapshotsRecalculated: counts.recalculated,
    },
  };
}

export async function executeDeleteValuationAnchorCommand(
  store: WorthlineStore,
  command: DeleteValuationAnchorCommand,
): Promise<CommandResult<{ changes: number }>> {
  const today = defaultToday(command.today);
  // #1437: the acquisition anchor starts the housing's history — deleting it
  // would silently amputate every snapshot before the next appraisal. It may be
  // edited (date/value), never removed.
  const anchor = await store.assets.readValuationAnchorById(command.anchorId);
  if (anchor?.kind === "acquisition") {
    return {
      ok: false,
      error: "El ancla de adquisición no se puede eliminar — edita su fecha o valor.",
    };
  }
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

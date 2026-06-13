"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
import {
  assertNotInvestmentAsset,
  checkOwnershipSplit,
  createManualAssetSafe,
  createLiabilitySafe,
} from "@worthline/domain";
import { redirect } from "next/navigation";

import {
  appendParam,
  createStableId,
  errorRedirectUrl,
  mapDomainViolation,
  parseAppreciationRateStrict,
  parseAssetCommandStrict,
  parseEntityId,
  parseMoneyMinorField,
  parseOwnership,
  parseLiabilityCommand,
  parseValuationAnchorStrict,
  parseAmortizationPlanStrict,
  parseBalanceAnchorStrict,
  parseDebtModelStrict,
  parseInterestRateRevisionStrict,
  parseValueUpdatePass,
  preserveFields,
  successRedirectUrl,
} from "../intake";

/**
 * Server actions for the /patrimonio section.
 * Copied and adapted from app/page.tsx server actions — uses intake v2 strict
 * parsers, anchors to row ids, and redirects back to /patrimonio.
 */

const ASSET_FORM_FIELDS = [
  "name",
  "type",
  "currentValue",
  "liquidityTier",
  "isPrimaryResidence",
  "ownershipPreset",
  "acquisitionDate",
  "acquisitionValue",
  "rate",
  "initialValuationDate",
  "initialValuationValue",
  "initialAdjustsPriorCurve",
];
const LIABILITY_FORM_FIELDS = [
  "name",
  "type",
  "balance",
  "associatedAssetId",
  "ownershipPreset",
];
const EDIT_ASSET_FIELDS = [
  "name",
  "type",
  "liquidityTier",
  "isPrimaryResidence",
  "ownershipPreset",
];

/** Base page URL for actions in this section — the patrimonio list. */
function baseUrl(formData: FormData): string {
  return (formData.get("currentUrl") as string) || "/patrimonio";
}

export async function createAssetAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const returnUrl = baseUrl(formData);

  const assetErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "asset",
      message,
      values: preserveFields(formData, ASSET_FORM_FIELDS, ["owner_"]),
    });

  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  const result = runWith((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return { ok: false, error: "Workspace no inicializado." };
    }

    const parsed = parseAssetCommandStrict(formData, workspace.members, Date.now());

    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    const {
      acquisitionDate,
      acquisitionValueMinor,
      annualAppreciationRate,
      initialValuation,
      ...assetCommand
    } = parsed.command;

    const domainResult = createManualAssetSafe(workspace, assetCommand);

    if (!domainResult.ok) {
      return { ok: false, error: mapDomainViolation(domainResult.violations[0]) };
    }

    store.assets.createManualAsset(assetCommand);

    if (assetCommand.type === "real_estate" && acquisitionDate && acquisitionValueMinor) {
      store.assets.addValuationAnchor({
        adjustsPriorCurve: true,
        assetId: assetCommand.id,
        id: createStableId("anchor", `${assetCommand.id}_acquisition`, Date.now()),
        valuationDate: acquisitionDate,
        valueMinor: acquisitionValueMinor,
      });
      store.assets.setAnnualAppreciationRate(
        assetCommand.id,
        annualAppreciationRate ?? null,
      );

      if (initialValuation) {
        store.assets.addValuationAnchor({
          ...initialValuation,
          assetId: assetCommand.id,
          id: createStableId("anchor", `${assetCommand.id}_initial`, Date.now() + 1),
        });
      }

      store.rippleHistoricalSnapshotsForValuation({
        assetId: assetCommand.id,
        fromDateKey: acquisitionDate,
        today: new Date().toISOString().slice(0, 10),
      });
    }

    return { ok: true, id: assetCommand.id };
  });

  if (!result.ok) {
    redirect(assetErrorUrl(result.error!));
  }

  redirect(successRedirectUrl("/patrimonio", "asset_added", result.id!));
}

export async function createLiabilityAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const returnUrl = baseUrl(formData);

  const liabilityErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "liability",
      message,
      values: preserveFields(formData, LIABILITY_FORM_FIELDS, ["owner_"]),
    });

  const balance = parseMoneyMinorField(formData, "balance");

  if (balance === null) {
    redirect(liabilityErrorUrl("El saldo de la deuda no es válido."));
  }

  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  const result = runWith((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return { ok: false, error: "Workspace no inicializado." };
    }

    const command = parseLiabilityCommand(formData, workspace.members, Date.now());
    const domainResult = createLiabilitySafe(workspace, command);

    if (!domainResult.ok) {
      return { ok: false, error: mapDomainViolation(domainResult.violations[0]) };
    }

    store.liabilities.createLiability(command);

    return { ok: true, id: command.id };
  });

  if (!result.ok) {
    redirect(liabilityErrorUrl(result.error!));
  }

  redirect(successRedirectUrl("/patrimonio", "liability_added", result.id!));
}

export async function deleteAssetAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  const changes = runWith((store) =>
    store.assets.softDeleteAsset(id, new Date().toISOString()),
  );

  if (changes === 0) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "No se encontró el elemento — puede que ya haya sido eliminado.",
      }),
    );
  }

  redirect(successRedirectUrl("/patrimonio", "deleted_recoverable"));
}

export async function deleteLiabilityAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const changes = runWith((store) =>
    store.liabilities.softDeleteLiability(id, new Date().toISOString()),
  );

  if (changes === 0) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "No se encontró el elemento — puede que ya haya sido eliminado.",
      }),
    );
  }

  redirect(successRedirectUrl("/patrimonio", "deleted_recoverable"));
}

export async function hardDeleteAssetAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  const changes = runWith((store) => store.assets.hardDeleteAsset(id));

  if (changes === 0) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "No se encontró el elemento en la papelera.",
      }),
    );
  }

  redirect(successRedirectUrl("/patrimonio", "hard_deleted"));
}

export async function hardDeleteLiabilityAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const changes = runWith((store) => store.liabilities.hardDeleteLiability(id));

  if (changes === 0) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "No se encontró el elemento en la papelera.",
      }),
    );
  }

  redirect(successRedirectUrl("/patrimonio", "hard_deleted"));
}

export async function emptyTrashAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  runWith((store) => store.emptyTrash());

  redirect(successRedirectUrl("/patrimonio", "trash_emptied"));
}

export async function restoreAssetAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  const changes = runWith((store) => store.assets.restoreAsset(id));

  if (changes === 0) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "No se encontró el elemento — puede que ya no esté en papelera.",
      }),
    );
  }

  redirect(successRedirectUrl("/patrimonio", "restored", id));
}

export async function restoreLiabilityAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const changes = runWith((store) => store.liabilities.restoreLiability(id));

  if (changes === 0) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "No se encontró el elemento — puede que ya no esté en papelera.",
      }),
    );
  }

  redirect(successRedirectUrl("/patrimonio", "restored", id));
}

export async function acknowledgeWarningAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const code = String(formData.get("code") ?? "").trim();
  const entityId = parseEntityId(formData, "entityId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!code || !entityId) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "No se pudo registrar el reconocimiento del aviso.",
      }),
    );
  }

  runWith((store) => store.acknowledgeWarning(code, entityId));
  redirect(successRedirectUrl("/patrimonio", "warning_acknowledged", entityId));
}

export async function updateAssetValuationAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const currentValue = parseMoneyMinorField(formData, "currentValue");

  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  if (currentValue === null) {
    redirect(
      errorRedirectUrl(`/patrimonio/${id}/editar`, {
        formId: "edit",
        message: "El valor del activo no es válido.",
        values: preserveFields(formData, ["currentValue"]),
      }),
    );
  }

  const asset = runWith(
    (store) => store.assets.readAssets().find((a) => a.id === id) ?? null,
  );

  // Domain guard (ADR 0006): an investment's value is always derived and must
  // never be hand-edited. Enforced here, at the caller, before the store write
  // (PRD #120 candidate 3). assertNotInvestmentAsset throws on an investment; we
  // map that to a user-facing Spanish message rather than letting it surface.
  if (asset) {
    try {
      assertNotInvestmentAsset(asset);
    } catch {
      redirect(
        errorRedirectUrl(`/patrimonio/${id}/editar`, {
          formId: "edit",
          message: mapDomainViolation({ code: "investment_manual_valuation_rejected" }),
          values: preserveFields(formData, ["currentValue"]),
        }),
      );
    }
  }

  runWith((store) => {
    store.assets.updateAssetValuation(id, currentValue);

    if (asset?.type === "real_estate") {
      const today = new Date().toISOString().slice(0, 10);
      upsertTodayMarketValuationAnchor(store, id, currentValue, today);

      const fromDateKey = firstHousingCurrentValueRippleDate(store, id, today);
      if (fromDateKey) {
        store.rippleHistoricalSnapshotsForValuation({
          assetId: id,
          fromDateKey,
          today,
        });
      }
    }
  });
  redirect(successRedirectUrl("/patrimonio", "saved", id));
}

export async function updateLiabilityBalanceAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const balance = parseMoneyMinorField(formData, "balance");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  if (balance === null) {
    redirect(
      errorRedirectUrl(`/patrimonio/${id}/editar`, {
        formId: "edit",
        message: "El saldo de la deuda no es válido.",
        values: preserveFields(formData, ["balance"]),
      }),
    );
  }

  runWith((store) => store.liabilities.updateLiabilityBalance(id, balance));
  redirect(successRedirectUrl("/patrimonio", "saved", id));
}

export async function batchValueUpdateAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  const result = runWith((store) => {
    const allAssets = store.assets.readAssets();
    const investmentIds = new Set(
      allAssets.filter((a) => a.type === "investment").map((a) => a.id),
    );
    const manualAssets = allAssets.filter((a) => a.type !== "investment");
    const liabilities = store.liabilities.readLiabilities();

    // Reject submissions that name an investment holding — their value is derived.
    for (const [key] of formData.entries()) {
      if (!key.startsWith("val_")) continue;
      const assetId = key.slice(4);
      if (investmentIds.has(assetId)) {
        return {
          ok: false,
          error: mapDomainViolation({ code: "value_update_investment_holding" }),
        };
      }
    }

    // Parse manual assets
    const assetCommands = parseValueUpdatePass(
      formData,
      manualAssets.map((a) => ({
        id: a.id,
        currentValueMinor: a.currentValue.amountMinor,
      })),
    );
    const liabilityCommands = parseValueUpdatePass(
      formData,
      liabilities.map((l) => ({
        id: l.id,
        currentValueMinor: l.currentBalance.amountMinor,
      })),
    );

    const allCommands = [...assetCommands, ...liabilityCommands];
    const errors = allCommands.filter(
      (cmd): cmd is { id: string; error: string } => "error" in cmd,
    );

    if (errors.length > 0) {
      return { ok: false, error: errors[0]!.error };
    }

    const valid = allCommands.filter(
      (cmd): cmd is { id: string; newValueMinor: number } => "newValueMinor" in cmd,
    );
    const assetUpdates = valid.filter((cmd) => manualAssets.some((a) => a.id === cmd.id));
    const liabilityUpdates = valid.filter((cmd) =>
      liabilities.some((l) => l.id === cmd.id),
    );

    store.operations.batchApplyAllValueUpdates(assetUpdates, liabilityUpdates);

    return { ok: true, count: valid.length };
  });

  if (!result.ok) {
    redirect(
      errorRedirectUrl("/patrimonio/actualizar", {
        message: result.error ?? "Error al actualizar valores.",
      }),
    );
  }

  redirect(
    appendParam(
      "/patrimonio",
      "ok",
      result.count === 0 ? "saved" : "valores_actualizados",
    ),
  );
}

export async function editAssetAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const isLiability = formData.get("isLiability") === "true";
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", { message: "Identificador no encontrado." }),
    );
  }

  const editErrorUrl = (message: string) =>
    errorRedirectUrl(`/patrimonio/${id}/editar`, {
      formId: "edit",
      message,
      values: preserveFields(
        formData,
        [...EDIT_ASSET_FIELDS, "type", "associatedAssetId"],
        ["owner_"],
      ),
    });

  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    redirect(
      editErrorUrl(
        isLiability
          ? "El nombre de la deuda es obligatorio."
          : "El nombre del activo es obligatorio.",
      ),
    );
  }

  if (isLiability) {
    const result = runWith((store) => {
      const workspace = store.workspace.readWorkspace();

      if (!workspace) {
        return { ok: false, error: "Workspace no inicializado." };
      }

      const ownership = parseOwnership(formData, workspace.members);
      const splitViolation = checkOwnershipSplit(workspace, ownership);

      if (splitViolation) {
        return { ok: false, error: mapDomainViolation(splitViolation) };
      }

      const liabilityType =
        formData.get("type") === "debt" ? ("debt" as const) : ("mortgage" as const);
      const associatedAssetId =
        String(formData.get("associatedAssetId") ?? "").trim() || null;

      store.liabilities.updateLiability(id, {
        name,
        type: liabilityType,
        associatedAssetId,
        ownership,
      });

      return { ok: true };
    });

    if (!result.ok) {
      redirect(editErrorUrl(result.error!));
    }

    redirect(successRedirectUrl("/patrimonio", "saved", id));
  }

  const result = runWith((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return { ok: false, error: "Workspace no inicializado." };
    }

    const type = parseAssetType(formData.get("type"));
    const liquidityTier = parseLiquidityTier(formData.get("liquidityTier"));
    const isPrimaryResidence = formData.get("isPrimaryResidence") === "on";

    const ownership = parseOwnership(formData, workspace.members, {
      completeShortfall: type !== "real_estate",
    });
    const splitViolation = checkOwnershipSplit(workspace, ownership, {
      allowKnownPartial: type === "real_estate",
    });

    if (splitViolation) {
      return { ok: false, error: mapDomainViolation(splitViolation) };
    }

    store.assets.updateAsset(id, {
      name,
      type,
      liquidityTier,
      isPrimaryResidence,
      ownership,
    });

    if (type === "real_estate") {
      const today = new Date().toISOString().slice(0, 10);
      const fromDateKey = firstHousingEventDate(store, id, today);

      if (fromDateKey) {
        store.rippleHistoricalSnapshotsForValuation({
          assetId: id,
          fromDateKey,
          today,
        });
      }
    }

    return { ok: true };
  });

  if (!result.ok) {
    redirect(editErrorUrl(result.error!));
  }

  redirect(successRedirectUrl("/patrimonio", "saved", id));
}

/**
 * Housing valuation editing (PRD #108, slice 6). All mutations of an asset's
 * appreciation rate and valuation anchors flow through these server actions.
 * Domain guard (R9): only a real_estate asset can carry a rate or anchors —
 * any other type is rejected with a Spanish message. After every mutation with
 * a past `fromDateKey` we ripple historical snapshots so /historico reflects the
 * recomputed curve (slice 4/5 wiring; the #114 E2E acceptance lives here).
 */

/** The editar page URL for a given holding — where every housing action returns. */
function editUrl(id: string): string {
  return `/patrimonio/${id}/editar`;
}

/** Read an asset by id, or null. Shared by the housing actions for the R9 guard. */
function findAsset(store: WorthlineStore, id: string) {
  return store.assets.readAssets().find((a) => a.id === id) ?? null;
}

function upsertTodayMarketValuationAnchor(
  store: WorthlineStore,
  assetId: string,
  valueMinor: number,
  today: string,
): void {
  const existing = store.assets
    .readValuationAnchors(assetId)
    .find((anchor) => anchor.valuationDate === today);

  if (existing) {
    store.assets.updateValuationAnchor(existing.id, {
      adjustsPriorCurve: true,
      valueMinor,
    });
    return;
  }

  store.assets.addValuationAnchor({
    adjustsPriorCurve: true,
    assetId,
    id: createStableId("anchor", `${assetId}_${today}`, Date.now()),
    valuationDate: today,
    valueMinor,
  });
}

function firstHousingCurrentValueRippleDate(
  store: WorthlineStore,
  assetId: string,
  today: string,
): string | null {
  const firstPastAnchorDate = store.assets
    .readValuationAnchors(assetId)
    .map((anchor) => anchor.valuationDate)
    .filter((dateKey) => dateKey < today)
    .sort()[0];

  if (firstPastAnchorDate) {
    return firstPastAnchorDate;
  }

  const firstSnapshotDate = store.snapshots
    .readSnapshotHoldings()
    .filter((row) => row.kind === "asset" && row.holdingId === assetId)
    .map((row) => row.dateKey)
    .filter((dateKey) => dateKey < today)
    .sort()[0];

  return firstSnapshotDate ?? null;
}

function firstHousingEventDate(
  store: WorthlineStore,
  assetId: string,
  today: string,
): string | null {
  const firstAnchorDate = store.assets
    .readValuationAnchors(assetId)
    .map((anchor) => anchor.valuationDate)
    .filter((dateKey) => dateKey <= today)
    .sort()[0];

  if (firstAnchorDate) {
    return firstAnchorDate;
  }

  const firstSnapshotDate = store.snapshots
    .readSnapshotHoldings()
    .filter((row) => row.kind === "asset" && row.holdingId === assetId)
    .map((row) => row.dateKey)
    .filter((dateKey) => dateKey <= today)
    .sort()[0];

  return firstSnapshotDate ?? null;
}

export async function setAppreciationRateAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  const parsed = parseAppreciationRateStrict(formData);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: "rate",
        message: parsed.error,
        values: preserveFields(formData, ["rate"]),
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = runWith((store) => {
    const asset = findAsset(store, id);

    if (!asset) {
      return { ok: false, error: "No se encontró el activo." };
    }

    if (asset.type !== "real_estate") {
      return {
        ok: false,
        error: "Solo los inmuebles pueden tener una tasa de revalorización.",
      };
    }

    store.assets.setAnnualAppreciationRate(id, parsed.rate);

    // A rate change ripples from the first anchor's date (PRD #108): re-evaluate
    // every snapshot on/after it from the new curve. No anchors → nothing to ripple.
    const anchors = store.assets.readValuationAnchors(id);
    const firstAnchorDate = anchors[0]?.valuationDate;

    if (firstAnchorDate && firstAnchorDate <= today) {
      store.rippleHistoricalSnapshotsForValuation({
        assetId: id,
        fromDateKey: firstAnchorDate,
        today,
      });
    }

    return { ok: true };
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { formId: "rate", message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "rate_saved", id));
}

export async function addValuationAnchorAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseValuationAnchorStrict(formData, id, Date.now(), today);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: "anchor",
        message: parsed.error,
        values: preserveFields(formData, [
          "valuationDate",
          "anchorValue",
          "adjustsPriorCurve",
        ]),
      }),
    );
  }

  const result = runWith((store) => {
    const asset = findAsset(store, id);

    if (!asset) {
      return { ok: false, error: "No se encontró el activo." };
    }

    if (asset.type !== "real_estate") {
      return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
    }

    store.assets.addValuationAnchor(parsed.command);
    store.rippleHistoricalSnapshotsForValuation({
      assetId: id,
      fromDateKey: parsed.command.valuationDate,
      today,
    });

    return { ok: true };
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { formId: "anchor", message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "anchor_added", id));
}

export async function updateValuationAnchorAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const anchorId = parseEntityId(formData, "anchorId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id || !anchorId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de tasación no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseValuationAnchorStrict(formData, id, Date.now(), today);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: `anchor-${anchorId}`,
        message: parsed.error,
        values: preserveFields(formData, [
          "valuationDate",
          "anchorValue",
          "adjustsPriorCurve",
        ]),
      }),
    );
  }

  const result = runWith((store) => {
    const asset = findAsset(store, id);

    if (!asset || asset.type !== "real_estate") {
      return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
    }

    // The new date may differ from the old one; ripple from the earlier of the
    // two so every snapshot the edit could affect is recomputed.
    const previous = store.assets.readValuationAnchors(id).find((a) => a.id === anchorId);
    const changes = store.assets.updateValuationAnchor(anchorId, {
      adjustsPriorCurve: parsed.command.adjustsPriorCurve,
      valuationDate: parsed.command.valuationDate,
      valueMinor: parsed.command.valueMinor,
    });

    if (changes === 0) {
      return {
        ok: false,
        error: "No se encontró la tasación — puede que ya se haya eliminado.",
      };
    }

    const fromDateKey =
      previous && previous.valuationDate < parsed.command.valuationDate
        ? previous.valuationDate
        : parsed.command.valuationDate;

    if (fromDateKey <= today) {
      store.rippleHistoricalSnapshotsForValuation({ assetId: id, fromDateKey, today });
    }

    return { ok: true };
  });

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: `anchor-${anchorId}`,
        message: result.error!,
      }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "anchor_saved", id));
}

export async function deleteValuationAnchorAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const anchorId = parseEntityId(formData, "anchorId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id || !anchorId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de tasación no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = runWith((store) => {
    const asset = findAsset(store, id);

    if (!asset || asset.type !== "real_estate") {
      return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
    }

    const removed = store.assets.readValuationAnchors(id).find((a) => a.id === anchorId);
    const changes = store.assets.deleteValuationAnchor(anchorId);

    if (changes === 0) {
      return {
        ok: false,
        error: "No se encontró la tasación — puede que ya se haya eliminado.",
      };
    }

    if (removed && removed.valuationDate <= today) {
      store.rippleHistoricalSnapshotsForValuation({
        assetId: id,
        fromDateKey: removed.valuationDate,
        today,
      });
    }

    return { ok: true };
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "anchor_deleted", id));
}

function parseAssetType(value: FormDataEntryValue | null) {
  if (value === "real_estate") return "real_estate" as const;
  if (value === "manual") return "manual" as const;
  return "cash" as const;
}

function parseLiquidityTier(value: FormDataEntryValue | null) {
  if (value === "market" || value === "term-locked" || value === "illiquid") {
    return value;
  }
  return "cash" as const;
}

/**
 * Debt-model editing (PRD #109, slice 10). All mutations of a liability's debt
 * model, amortization plan, interest-rate revisions and balance anchors flow
 * through these server actions. Domain guard (R9): only a liability can carry a
 * debt model; an amortizable plan/revisions require the amortizable model, and
 * balance anchors require the revolving/informal model — any mismatch is
 * rejected with a Spanish message. After every mutation we ripple historical
 * snapshots with the matching kind so /historico reflects the recomputed debt
 * curve (slice 9 wiring; the deferred #118 acceptance lives here).
 */

/** Read a liability by id, or null. Shared by the debt actions for the R9 guard. */
function findLiability(store: WorthlineStore, id: string) {
  return store.liabilities.readLiabilities().find((l) => l.id === id) ?? null;
}

export async function setDebtModelAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const parsed = parseDebtModelStrict(formData);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "debtModel", message: parsed.error }),
    );
  }

  const result = runWith((store) => {
    const liability = findLiability(store, id);

    if (!liability) {
      return { ok: false, error: "No se encontró la deuda." };
    }

    store.liabilities.setDebtModel(id, parsed.model);
    return { ok: true };
  });

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "debtModel", message: result.error! }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "debt_model_saved", id));
}

/** Guard a debt mutation to liabilities carrying the expected model. */
function requireDebtModel(
  store: WorthlineStore,
  id: string,
  expected: DebtModelGuard,
): { ok: true } | { ok: false; error: string } {
  const liability = findLiability(store, id);

  if (!liability) {
    return { ok: false, error: "No se encontró la deuda." };
  }

  const model = store.liabilities.readDebtModel(id);

  if (expected === "amortizable" && model !== "amortizable") {
    return {
      ok: false,
      error: "El plan de amortización solo aplica a deudas amortizables.",
    };
  }

  if (expected === "anchorable" && model !== "revolving" && model !== "informal") {
    return {
      ok: false,
      error: "Los saldos solo aplican a deudas revolving o informales.",
    };
  }

  return { ok: true };
}

type DebtModelGuard = "amortizable" | "anchorable";

export async function saveAmortizationPlanAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseAmortizationPlanStrict(formData, id, Date.now(), today);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: "plan",
        message: parsed.error,
        values: preserveFields(formData, [
          "initialCapital",
          "annualInterestRate",
          "termMonths",
          "startDate",
        ]),
      }),
    );
  }

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    const existing = store.liabilities.readAmortizationPlan(id);

    if (existing) {
      store.liabilities.updateAmortizationPlan(existing.id, {
        annualInterestRate: parsed.command.annualInterestRate,
        initialCapitalMinor: parsed.command.initialCapitalMinor,
        startDate: parsed.command.startDate,
        termMonths: parsed.command.termMonths,
      });
    } else {
      store.liabilities.createAmortizationPlan(parsed.command);
    }

    store.rippleHistoricalSnapshotsForDebt({
      kind: "amortizable-plan",
      liabilityId: id,
      today,
    });

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { formId: "plan", message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "plan_saved", id));
}

export async function deleteAmortizationPlanAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const planId = parseEntityId(formData, "planId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id || !planId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador del plan no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Capture the plan's startDate BEFORE deleting — needed for the ripple.
    const plan = store.liabilities.readAmortizationPlan(id);

    if (!plan) {
      return {
        ok: false as const,
        error: "No se encontró el plan — puede que ya se haya eliminado.",
      };
    }

    const startDate = plan.startDate;
    const changes = store.liabilities.deleteAmortizationPlan(plan.id);

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró el plan — puede que ya se haya eliminado.",
      };
    }

    // Ripple AFTER deleting so the curve has no plan. The "amortizable-revision"
    // kind (generateDates=[], recalcFrom=startDate) recalculates every existing
    // snapshot ≥ startDate against the now-planless curve, which falls back to
    // currentBalance — correctly reflecting the plan's removal in history.
    // (The "amortizable-plan" kind cannot be used here because it early-returns
    // when curve.plan is null.)
    if (startDate <= today) {
      store.rippleHistoricalSnapshotsForDebt({
        fromDateKey: startDate,
        kind: "amortizable-revision",
        liabilityId: id,
        today,
      });
    }

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "plan_deleted", id));
}

export async function addInterestRateRevisionAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const planId = parseEntityId(formData, "planId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id || !planId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador del plan no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseInterestRateRevisionStrict(formData, planId, Date.now(), today);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: "revision",
        message: parsed.error,
        values: preserveFields(formData, ["revisionDate", "newAnnualInterestRate"]),
      }),
    );
  }

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    store.liabilities.addInterestRateRevision(parsed.command);

    if (parsed.command.revisionDate <= today) {
      store.rippleHistoricalSnapshotsForDebt({
        fromDateKey: parsed.command.revisionDate,
        kind: "amortizable-revision",
        liabilityId: id,
        today,
      });
    }

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "revision", message: result.error! }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "revision_added", id));
}

export async function updateInterestRateRevisionAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const planId = parseEntityId(formData, "planId");
  const revisionId = parseEntityId(formData, "revisionId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id || !planId || !revisionId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de la revisión no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseInterestRateRevisionStrict(formData, planId, Date.now(), today);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: `revision-${revisionId}`,
        message: parsed.error,
        values: preserveFields(formData, ["revisionDate", "newAnnualInterestRate"]),
      }),
    );
  }

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Ripple from the earlier of the old/new date so every affected snapshot recomputes.
    const previous = store.liabilities
      .readInterestRateRevisions(planId)
      .find((r) => r.id === revisionId);
    const changes = store.liabilities.updateInterestRateRevision(revisionId, {
      newAnnualInterestRate: parsed.command.newAnnualInterestRate,
      revisionDate: parsed.command.revisionDate,
    });

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró la revisión — puede que ya se haya eliminado.",
      };
    }

    const fromDateKey =
      previous && previous.revisionDate < parsed.command.revisionDate
        ? previous.revisionDate
        : parsed.command.revisionDate;

    if (fromDateKey <= today) {
      store.rippleHistoricalSnapshotsForDebt({
        fromDateKey,
        kind: "amortizable-revision",
        liabilityId: id,
        today,
      });
    }

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: `revision-${revisionId}`,
        message: result.error!,
      }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "revision_saved", id));
}

export async function deleteInterestRateRevisionAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const revisionId = parseEntityId(formData, "revisionId");
  const planId = parseEntityId(formData, "planId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id || !revisionId || !planId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de la revisión no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    const removed = store.liabilities
      .readInterestRateRevisions(planId)
      .find((r) => r.id === revisionId);
    const changes = store.liabilities.deleteInterestRateRevision(revisionId);

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró la revisión — puede que ya se haya eliminado.",
      };
    }

    if (removed && removed.revisionDate <= today) {
      store.rippleHistoricalSnapshotsForDebt({
        fromDateKey: removed.revisionDate,
        kind: "amortizable-revision",
        liabilityId: id,
        today,
      });
    }

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "revision_deleted", id));
}

export async function addBalanceAnchorAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseBalanceAnchorStrict(formData, id, Date.now(), today);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: "balanceAnchor",
        message: parsed.error,
        values: preserveFields(formData, ["anchorDate", "balance"]),
      }),
    );
  }

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "anchorable");

    if (!guard.ok) {
      return guard;
    }

    store.liabilities.addBalanceAnchor(parsed.command);
    store.rippleHistoricalSnapshotsForDebt({
      fromDateKey: parsed.command.anchorDate,
      kind: "anchor",
      liabilityId: id,
      today,
    });

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "balanceAnchor", message: result.error! }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "balance_anchor_added", id));
}

export async function updateBalanceAnchorAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const anchorId = parseEntityId(formData, "anchorId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id || !anchorId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador del saldo no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseBalanceAnchorStrict(formData, id, Date.now(), today);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: `balanceAnchor-${anchorId}`,
        message: parsed.error,
        values: preserveFields(formData, ["anchorDate", "balance"]),
      }),
    );
  }

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "anchorable");

    if (!guard.ok) {
      return guard;
    }

    const previous = store.liabilities
      .readBalanceAnchors(id)
      .find((a) => a.id === anchorId);
    const changes = store.liabilities.updateBalanceAnchor(anchorId, {
      anchorDate: parsed.command.anchorDate,
      balanceMinor: parsed.command.balanceMinor,
    });

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró el saldo — puede que ya se haya eliminado.",
      };
    }

    const fromDateKey =
      previous && previous.anchorDate < parsed.command.anchorDate
        ? previous.anchorDate
        : parsed.command.anchorDate;

    if (fromDateKey <= today) {
      store.rippleHistoricalSnapshotsForDebt({
        fromDateKey,
        kind: "anchor",
        liabilityId: id,
        today,
      });
    }

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: `balanceAnchor-${anchorId}`,
        message: result.error!,
      }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "balance_anchor_saved", id));
}

export async function deleteBalanceAnchorAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const id = parseEntityId(formData);
  const anchorId = parseEntityId(formData, "anchorId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id || !anchorId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador del saldo no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "anchorable");

    if (!guard.ok) {
      return guard;
    }

    const removed = store.liabilities
      .readBalanceAnchors(id)
      .find((a) => a.id === anchorId);
    const changes = store.liabilities.deleteBalanceAnchor(anchorId);

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró el saldo — puede que ya se haya eliminado.",
      };
    }

    if (removed && removed.anchorDate <= today) {
      store.rippleHistoricalSnapshotsForDebt({
        fromDateKey: removed.anchorDate,
        kind: "anchor",
        liabilityId: id,
        today,
      });
    }

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "balance_anchor_deleted", id));
}

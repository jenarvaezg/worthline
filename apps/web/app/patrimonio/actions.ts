"use server";

import {
  runActionWithStore,
  runDatedFactAction,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
  appendParam,
  createStableId,
  errorRedirectUrl,
  mapDomainViolation,
  parseAmortizationPlanStrict,
  parseAppreciationRateStrict,
  parseBalanceAnchorStrict,
  parseDebtModelStrict,
  parseEarlyRepaymentStrict,
  parseEntityId,
  parseInterestRateRevisionStrict,
  parseMoneyMinorField,
  parseOwnership,
  parseValuationAnchorStrict,
  parseValuationCadenceStrict,
  parseValueUpdatePass,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import { type WorthlineStore } from "@web/store";
import {
  assertNotInvestmentAsset,
  type Clock,
  checkOwnershipSplit,
  checkSinglePrimaryResidence,
  effectiveAmortizationPlan,
  isHousingAsset,
  isValueUpdateEligible,
  systemClock,
} from "@worthline/domain";
import { redirect } from "next/navigation";
import {
  CURRENT_STATE_DEBT_FIELD_NAMES,
  deriveCurrentStateDebt,
} from "./current-state-debt";
import {
  type BalanceHistoryRowInput,
  composeBalanceHistoryRebaselines,
  previewBalanceHistoryImport,
} from "./import-balance-history";
import {
  persistBalanceHistoryImport,
  readBalanceHistoryDebtContext,
} from "./persist-balance-history-import";
import { persistCurrentStateAmortization } from "./persist-current-state-debt";
import {
  deriveRecalibrationRebaseline,
  RECALIBRATE_DEBT_FIELD_NAMES,
  validateRecalibrateDebt,
} from "./recalibrate-debt";

/**
 * Server actions for the /patrimonio section.
 * Copied and adapted from app/page.tsx server actions — uses intake v2 strict
 * parsers, anchors to row ids, and redirects back to /patrimonio.
 */

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

function isClock(value: unknown): value is Clock {
  return (
    typeof value === "object" && value !== null && "now" in value && "today" in value
  );
}

export async function deleteAssetAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  const changes = await runActionWithStore(
    (store) => store.assets.softDeleteAsset(id, _clock.now()),
    _store,
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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const changes = await runActionWithStore(
    (store) => store.liabilities.softDeleteLiability(id, _clock.now()),
    _store,
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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  const changes = await runActionWithStore(
    (store) => store.assets.hardDeleteAsset(id),
    _store,
  );

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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const changes = await runActionWithStore(
    (store) => store.liabilities.hardDeleteLiability(id),
    _store,
  );

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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));

  await runActionWithStore((store) => store.emptyTrash(), _store);

  redirect(successRedirectUrl("/patrimonio", "trash_emptied"));
}

export async function restoreAssetAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  const changes = await runActionWithStore(
    (store) => store.assets.restoreAsset(id),
    _store,
  );

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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const changes = await runActionWithStore(
    (store) => store.liabilities.restoreLiability(id),
    _store,
  );

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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));
  const code = String(formData.get("code") ?? "").trim();
  const entityId = parseEntityId(formData, "entityId");

  if (!code || !entityId) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "No se pudo registrar el reconocimiento del aviso.",
      }),
    );
  }

  await runActionWithStore((store) => store.acknowledgeWarning(code, entityId), _store);
  redirect(successRedirectUrl("/patrimonio", "warning_acknowledged", entityId));
}

export async function updateAssetValuationAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const currentValue = parseMoneyMinorField(formData, "currentValue");

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

  const asset = await runActionWithStore(
    async (store) => (await store.assets.readAssets()).find((a) => a.id === id) ?? null,
    _store,
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

  await runActionWithStore(async (store) => {
    if (asset?.type === "real_estate") {
      // Full atomic seam (ADR 0020): updateAssetValuation + upsert-today-anchor
      // + ripple all behind one transaction; from-date derived inside the seam.
      await store.recordHousingValuationAndRipple(id, currentValue);
    } else {
      await store.assets.updateAssetValuation(id, currentValue);
    }
  }, _store);
  redirect(successRedirectUrl("/patrimonio", "saved", id));
}

export async function updateLiabilityBalanceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const balance = parseMoneyMinorField(formData, "balance");

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

  await runActionWithStore(
    (store) => store.liabilities.updateLiabilityBalance(id, balance),
    _store,
  );
  redirect(successRedirectUrl("/patrimonio", "saved", id));
}

export async function batchValueUpdateAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));

  const result = await runActionWithStore(async (store) => {
    const allAssets = await store.assets.readAssets();
    // The catalog seam decides who the pass hand-updates: every holding whose
    // valuation method is not derived (ADR 0014) — no inline instrument list.
    const manualAssets = allAssets.filter(isValueUpdateEligible);
    const assetsById = new Map(allAssets.map((a) => [a.id, a]));
    const liabilities = await store.liabilities.readLiabilities();

    // Reject submissions that name a derived holding (investment or connected-source
    // coin collection) — their value is computed from sub-detail, never hand-set.
    // Ask the catalog seam per submitted holding instead of an inline id-set.
    for (const [key] of formData.entries()) {
      if (!key.startsWith("val_")) continue;
      const asset = assetsById.get(key.slice(4));
      if (asset && !isValueUpdateEligible(asset)) {
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

    await store.operations.batchApplyAllValueUpdates(assetUpdates, liabilityUpdates);

    return { ok: true, count: valid.length };
  }, _store);

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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const isLiability = formData.get("isLiability") === "true";

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
    const result = await runActionWithStore(async (store) => {
      const workspace = await store.workspace.readWorkspace();

      if (!workspace) {
        return { ok: false, error: "Workspace no inicializado." };
      }

      const liabilityType =
        formData.get("type") === "debt" ? ("debt" as const) : ("mortgage" as const);
      const associatedAssetId =
        String(formData.get("associatedAssetId") ?? "").trim() || null;

      // #171: a debt associated to a co-owned home mirrors the asset's split,
      // which may be a known partial (e.g. 75% mine, 25% a non-member's). So a
      // debt on a real_estate asset accepts a partial split, exactly like the
      // asset; a standalone debt still totals 100%.
      const associatedAsset = associatedAssetId
        ? ((await store.assets.readAssets()).find((a) => a.id === associatedAssetId) ??
          null)
        : null;
      const allowKnownPartial = associatedAsset?.type === "real_estate";

      const ownership = parseOwnership(formData, workspace.members, {
        completeShortfall: !allowKnownPartial,
      });
      const splitViolation = checkOwnershipSplit(workspace, ownership, {
        allowKnownPartial,
      });

      if (splitViolation) {
        return { ok: false, error: mapDomainViolation(splitViolation) };
      }

      // #172 / ADR 0020: an ownership-split change is a retroactive parameter
      // edit that ripples per-member snapshot history; a rename (same split) does
      // not. The ownership seam folds the persist + the conditional scope-axis
      // ripple into one atomic call, capturing the previous split behind the seam.
      await store.updateLiabilityAndRippleOwnership(id, {
        name,
        type: liabilityType,
        associatedAssetId,
        ownership,
      });

      return { ok: true };
    }, _store);

    if (!result.ok) {
      redirect(editErrorUrl(result.error!));
    }

    redirect(successRedirectUrl("/patrimonio", "saved", id));
  }

  const result = await runActionWithStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();

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

    if (isPrimaryResidence) {
      const primaryViolation = checkSinglePrimaryResidence(
        await store.assets.readAssets(),
        { assetId: id, isPrimaryResidence },
      );

      if (primaryViolation) {
        return { ok: false, error: mapDomainViolation(primaryViolation) };
      }
    }

    // #172 / ADR 0020: an ownership-split change ripples per-member snapshot
    // history. The ownership seam folds the persist + the conditional scope-axis
    // ripple into one atomic call; for a real_estate asset it dispatches to the
    // housing curve ripple, which already re-weights every affected snapshot from
    // the asset's new split. The previous split is captured behind the seam.
    await store.updateAssetAndRippleOwnership(id, {
      name,
      type,
      liquidityTier,
      isPrimaryResidence,
      ownership,
    });

    return { ok: true };
  }, _store);

  if (!result.ok) {
    redirect(editErrorUrl(result.error!));
  }

  redirect(successRedirectUrl("/patrimonio", "saved", id));
}

/**
 * Housing valuation editing (PRD #108, slice 6). All mutations of an asset's
 * appreciation rate and valuation anchors flow through these server actions.
 * Domain guard (R9): only a real_estate asset can carry a rate or anchors —
 * any other type is rejected with a Spanish message. After every past-dated
 * mutation the seam ripples historical snapshots so /historico reflects the
 * recomputed curve (slice 4/5 wiring; the #114 E2E acceptance lives here).
 */

/** The editar page URL for a given holding — where every housing action returns. */
function editUrl(id: string): string {
  return `/patrimonio/${id}/editar`;
}

/** Read an asset by id, or null. Shared by the housing actions for the R9 guard. */
async function findAsset(store: WorthlineStore, id: string) {
  return (await store.assets.readAssets()).find((a) => a.id === id) ?? null;
}

export async function setAppreciationRateAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

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

  const result = await runActionWithStore(async (store) => {
    const asset = await findAsset(store, id);

    if (!asset) {
      return { ok: false, error: "No se encontró el activo." };
    }

    if (!isHousingAsset(asset)) {
      return {
        ok: false,
        error: "Solo los inmuebles pueden tener una tasa de revalorización.",
      };
    }

    // The persist + from-date derivation + ripple all ride the seam (ADR 0020).
    // The seam derives min(first anchor, earliest snapshot) behind the seam (#184).
    await store.setAnnualAppreciationRateAndRipple(id, parsed.rate);

    return { ok: true };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { formId: "rate", message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "rate_saved", id));
}

export async function addValuationAnchorAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  const today = _clock.today();
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

  const result = await runActionWithStore(async (store) => {
    const asset = await findAsset(store, id);

    if (!asset) {
      return { ok: false, error: "No se encontró el activo." };
    }

    if (!isHousingAsset(asset)) {
      return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
    }

    // Persist + ripple ride the valuation seam (ADR 0020), atomically.
    await store.addValuationAnchorAndRipple(parsed.command, { today });

    return { ok: true };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { formId: "anchor", message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "anchor_added", id));
}

export async function updateValuationAnchorAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const anchorId = parseEntityId(formData, "anchorId");

  if (!id || !anchorId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de tasación no encontrado.",
      }),
    );
  }

  const today = _clock.today();
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

  const result = await runActionWithStore(async (store) => {
    const asset = await findAsset(store, id);

    if (!asset || !isHousingAsset(asset)) {
      return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
    }

    // Persist + ripple ride the valuation seam (ADR 0020): it reads the previous
    // anchor, ripples from the earlier of the old/new date, and guards the
    // future, all atomically.
    const changes = await store.updateValuationAnchorAndRipple(
      anchorId,
      {
        adjustsPriorCurve: parsed.command.adjustsPriorCurve,
        valuationDate: parsed.command.valuationDate,
        valueMinor: parsed.command.valueMinor,
      },
      { today },
    );

    if (changes === 0) {
      return {
        ok: false,
        error: "No se encontró la tasación — puede que ya se haya eliminado.",
      };
    }

    return { ok: true };
  }, _store);

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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const anchorId = parseEntityId(formData, "anchorId");

  if (!id || !anchorId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de tasación no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  const result = await runActionWithStore(async (store) => {
    const asset = await findAsset(store, id);

    if (!asset || !isHousingAsset(asset)) {
      return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
    }

    // Delete + ripple ride the valuation seam (ADR 0020): it captures the deleted
    // anchor's date behind the seam and guards the future, atomically.
    const changes = await store.deleteValuationAnchorAndRipple(anchorId, { today });

    if (changes === 0) {
      return {
        ok: false,
        error: "No se encontró la tasación — puede que ya se haya eliminado.",
      };
    }

    return { ok: true };
  }, _store);

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
  if (
    value === "market" ||
    value === "term-locked" ||
    value === "illiquid" ||
    value === "housing"
  ) {
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
async function findLiability(store: WorthlineStore, id: string) {
  return (await store.liabilities.readLiabilities()).find((l) => l.id === id) ?? null;
}

export async function setDebtModelAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

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

  const result = await runActionWithStore(async (store) => {
    const liability = await findLiability(store, id);

    if (!liability) {
      return { ok: false, error: "No se encontró la deuda." };
    }

    await store.liabilities.setDebtModel(id, parsed.model);
    return { ok: true };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "debtModel", message: result.error! }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "debt_model_saved", id));
}

export async function setValuationCadenceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const parsed = parseValuationCadenceStrict(formData);

  if (!parsed.ok) {
    redirect(errorRedirectUrl(editUrl(id), { formId: "cadence", message: parsed.error }));
  }

  const today = _clock.today();

  const result = await runActionWithStore(async (store) => {
    const liability = await findLiability(store, id);

    if (!liability) {
      return { ok: false, error: "No se encontró la deuda." };
    }

    // Persist + re-ripple ride the seam (ADR 0020 / 0031): the cadence change is a
    // parameter edit, so the seam recuts the whole modeled curve behind it.
    await store.setValuationCadenceAndRipple(id, parsed.cadence, { today });
    return { ok: true };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "cadence", message: result.error! }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "valuation_cadence_saved", id));
}

export async function setHousingValuationCadenceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  const parsed = parseValuationCadenceStrict(formData);

  if (!parsed.ok) {
    redirect(errorRedirectUrl(editUrl(id), { formId: "cadence", message: parsed.error }));
  }

  const today = _clock.today();

  const result = await runActionWithStore(async (store) => {
    const asset = await findAsset(store, id);

    if (!asset) {
      return { ok: false, error: "No se encontró el activo." };
    }

    if (!isHousingAsset(asset)) {
      return {
        ok: false,
        error: "Solo los inmuebles pueden tener una cadencia de valoración.",
      };
    }

    // Persist + re-ripple ride the seam (ADR 0020 / 0031): the cadence change is a
    // parameter edit, so the seam recuts the whole appreciation curve behind it.
    await store.setHousingValuationCadenceAndRipple(id, parsed.cadence, { today });
    return { ok: true };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "cadence", message: result.error! }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "valuation_cadence_saved", id));
}

/** Guard a debt mutation to liabilities carrying the expected model. */
async function requireDebtModel(
  store: WorthlineStore,
  id: string,
  expected: DebtModelGuard,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const liability = await findLiability(store, id);

  if (!liability) {
    return { ok: false, error: "No se encontró la deuda." };
  }

  const model = await store.liabilities.readDebtModel(id);

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

/**
 * "Alta por estado actual" on the advanced edit surface (ADR 0056, PRD #670 S2,
 * #677) — a liability's FIRST amortization plan, declared from what the user
 * owes today rather than the original conditions (ADR 0019's origin-declared
 * form stays untouched, offered alongside). Re-validates with the same pure
 * module the live honesty check renders (`current-state-debt.ts`), then
 * persists the derived plan row + the `startsAtBaseline` re-baseline together
 * (`persistCurrentStateAmortization`) — the #676 review's requirement that a
 * current-state debt never exists without a plan row for future revisions/
 * early repayments to hang off.
 */
export async function saveCurrentStateAmortizationAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  const inputMode = formData.get("csInputMode") === "payment" ? "payment" : "rate";
  const endDate = String(formData.get("csEndDate") ?? "").trim();
  const nextPaymentDate = String(formData.get("csNextPaymentDate") ?? "").trim();
  const originalSigningDate = String(formData.get("csOriginalSigningDate") ?? "").trim();
  const values = preserveFields(formData, [...CURRENT_STATE_DEBT_FIELD_NAMES]);

  const derived = deriveCurrentStateDebt({
    annualRatePercent: String(formData.get("csAnnualRate") ?? ""),
    baselineDate: today,
    endDate,
    inputMode,
    monthlyPayment: String(formData.get("csMonthlyPayment") ?? ""),
    nextPaymentDate,
    originalSigningDate,
    outstandingBalance: String(formData.get("csOutstandingBalance") ?? ""),
  });

  if (!derived.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: "currentStateDebt",
        message: derived.error,
        values,
      }),
    );
  }

  const result = await runActionWithStore(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    const existing = await store.liabilities.readAmortizationPlan(id);

    if (existing) {
      return {
        ok: false as const,
        error: "Esta deuda ya tiene un plan de amortización.",
      };
    }

    await persistCurrentStateAmortization(
      store,
      id,
      derived,
      {
        baselineDate: today,
        endDate,
        inputMode,
        nextPaymentDate,
        originalSigningDate: originalSigningDate || null,
      },
      Date.now(),
      today,
    );

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: "currentStateDebt",
        message: result.error!,
        values,
      }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "current_state_debt_saved", id));
}

/**
 * "Recalibrar con saldo real" on the advanced edit surface (ADR 0056, PRD #670
 * S3, #678) — the drift repair for an EXISTING amortizable debt. Declares a
 * fresh balance re-baseline at the given date (the SAME dated-fact kind S1/S2
 * use, `startsAtBaseline: false` here — it corrects a running curve, it does
 * not redefine the debt's origin) and rides `addBalanceRebaselineAndRipple`
 * for the forward-only ripple + audit trail (ADR 0012). Rate, end date and
 * next-cuota date are NOT re-entered: `effectiveAmortizationPlan` resolves
 * whichever plan or prior re-baseline currently governs the declared date, and
 * `deriveRecalibrationRebaseline` folds in any rate revisions on/before it.
 */
export async function recalibrateDebtBalanceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  const values = preserveFields(formData, [...RECALIBRATE_DEBT_FIELD_NAMES]);

  const validated = validateRecalibrateDebt({
    balanceDate: String(formData.get("rbBalanceDate") ?? "").trim(),
    outstandingBalance: String(formData.get("rbOutstandingBalance") ?? ""),
    today,
  });

  if (!validated.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: "recalibrateDebt",
        message: validated.error,
        values,
      }),
    );
  }

  const result = await runDatedFactAction(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Gate on the effective CURVE, not the plan row (#678 review): an imported
    // current-state debt can be rebaselined with no plan row at all (S1's
    // `startsAtBaseline` fact alone governs the curve) — that debt still has a
    // valid schedule to recalibrate, so requiring a plan row would falsely
    // reject it. Revisions hang off `planId`, so they only exist with a plan.
    const [plan, rebaselines] = await Promise.all([
      store.liabilities.readAmortizationPlan(id),
      store.liabilities.readBalanceRebaselines(id),
    ]);
    const revisions = plan
      ? await store.liabilities.readInterestRateRevisions(plan.id)
      : [];

    const effective = effectiveAmortizationPlan({
      balanceRebaselines: rebaselines,
      ...(plan
        ? {
            plan: {
              annualInterestRate: plan.annualInterestRate,
              disbursementDate: plan.disbursementDate,
              firstPaymentDate: plan.firstPaymentDate,
              initialCapitalMinor: plan.initialCapitalMinor,
              termMonths: plan.termMonths,
            },
          }
        : {}),
      targetDate: validated.balanceDate,
    });

    const derived = deriveRecalibrationRebaseline({
      balanceDate: validated.balanceDate,
      effective,
      revisions,
    });

    if (!derived.ok) {
      return derived;
    }

    await store.addBalanceRebaselineAndRipple(
      {
        annualInterestRate: derived.annualInterestRate,
        baselineDate: validated.balanceDate,
        endDate: derived.endDate,
        id: createStableId("rebaseline", id, Date.now()),
        liabilityId: id,
        nextPaymentDate: derived.nextPaymentDate,
        outstandingBalanceMinor: validated.outstandingBalanceMinor,
        startsAtBaseline: false,
      },
      { today },
    );

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: "recalibrateDebt",
        message: result.error!,
        values,
      }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "debt_recalibrated", id));
}

/**
 * Import a balance-history series as a chain of re-baselines (ADR 0056, #696).
 * Consumed by #764 S5 — no UI of its own. Rows arrive as JSON in `rows`;
 * preview/validation runs in the pure module, confirm rides
 * `importBalanceHistoryAndRipple` for ONE atomic ripple from the oldest checkpoint.
 */
export async function importBalanceHistoryAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  let rows: BalanceHistoryRowInput[];
  try {
    rows = JSON.parse(String(formData.get("rows") ?? "[]")) as BalanceHistoryRowInput[];
    if (!Array.isArray(rows)) throw new Error("not an array");
  } catch {
    redirect(
      errorRedirectUrl(editUrl(id), {
        message: "La serie de saldos no es válida.",
      }),
    );
  }

  const result = await runDatedFactAction(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");
    if (!guard.ok) return guard;

    const ctx = await readBalanceHistoryDebtContext(store, id, today);
    const preview = previewBalanceHistoryImport(rows, ctx);
    const composed = composeBalanceHistoryRebaselines(preview, ctx);

    if (composed.length === 0) {
      return { error: "No hay saldos válidos que importar.", ok: false as const };
    }

    await persistBalanceHistoryImport(store, id, composed, today);
    return { created: composed.length, ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        message: result.error!,
      }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "balance_history_imported", id));
}

export async function saveAmortizationPlanAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const today = _clock.today();
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
          "disbursementDate",
          "firstPaymentDate",
        ]),
      }),
    );
  }

  const result = await runActionWithStore(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    const existing = await store.liabilities.readAmortizationPlan(id);

    // Persist + ripple ride the debt seam (ADR 0020), atomically; the
    // amortizable-plan ripple derives its per-cuota date series behind the seam.
    if (existing) {
      await store.updateAmortizationPlanAndRipple(
        existing.id,
        {
          annualInterestRate: parsed.command.annualInterestRate,
          disbursementDate: parsed.command.disbursementDate,
          firstPaymentDate: parsed.command.firstPaymentDate,
          initialCapitalMinor: parsed.command.initialCapitalMinor,
          termMonths: parsed.command.termMonths,
        },
        { liabilityId: id, today },
      );
    } else {
      await store.createAmortizationPlanAndRipple(parsed.command, { today });
    }

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { formId: "plan", message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "plan_saved", id));
}

export async function deleteAmortizationPlanAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const planId = parseEntityId(formData, "planId");

  if (!id || !planId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador del plan no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  const result = await runActionWithStore(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Delete + ripple ride the debt seam (ADR 0020): it captures the plan's
    // disbursement date BEFORE deleting (the floor for the planless ripple,
    // ADR 0019 #188), then recalculates every snapshot ≥ that floor against the
    // now-planless curve (the amortizable-revision kind, which falls back to
    // currentBalance), all atomically. `planId` selects the row; the liability is
    // resolved from `id`.
    const changes = await store.deleteAmortizationPlanAndRipple({
      liabilityId: id,
      today,
    });

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró el plan — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "plan_deleted", id));
}

export async function addInterestRateRevisionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const planId = parseEntityId(formData, "planId");

  if (!id || !planId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador del plan no encontrado.",
      }),
    );
  }

  const today = _clock.today();
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

  const result = await runDatedFactAction(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020); the future guard moves
    // behind the seam.
    await store.addInterestRateRevisionAndRipple(parsed.command, {
      liabilityId: id,
      today,
    });

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "revision", message: result.error! }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "revision_added", id));
}

export async function updateInterestRateRevisionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const planId = parseEntityId(formData, "planId");
  const revisionId = parseEntityId(formData, "revisionId");

  if (!id || !planId || !revisionId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de la revisión no encontrado.",
      }),
    );
  }

  const today = _clock.today();
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

  const result = await runDatedFactAction(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020 / 0025): it reads the OLD
    // revision date behind the seam, ripples from the earlier of the old/new date,
    // and guards the future. The action no longer pre-reads the row.
    const changes = await store.updateInterestRateRevisionAndRipple(
      revisionId,
      {
        newAnnualInterestRate: parsed.command.newAnnualInterestRate,
        revisionDate: parsed.command.revisionDate,
      },
      { today },
    );

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró la revisión — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  }, _store);

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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const revisionId = parseEntityId(formData, "revisionId");
  const planId = parseEntityId(formData, "planId");

  if (!id || !revisionId || !planId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de la revisión no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  const result = await runActionWithStore(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Delete + ripple ride the debt seam (ADR 0020 / 0025): it reads the removed
    // revision's date behind the seam, recalculates from it, and guards the future.
    // The action no longer pre-reads the row.
    const changes = await store.deleteInterestRateRevisionAndRipple(revisionId, {
      today,
    });

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró la revisión — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "revision_deleted", id));
}

export async function addEarlyRepaymentAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const planId = parseEntityId(formData, "planId");

  if (!id || !planId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador del plan no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  const parsed = parseEarlyRepaymentStrict(formData, planId, Date.now(), today);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: "repayment",
        message: parsed.error,
        values: preserveFields(formData, ["repaymentDate", "amount", "mode"]),
      }),
    );
  }

  const result = await runDatedFactAction(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020): a past repayment is a dated
    // fact that generates its own snapshot (the "amortizable-repayment" kind); the
    // future guard moves behind the seam.
    await store.addEarlyRepaymentAndRipple(parsed.command, { liabilityId: id, today });

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "repayment", message: result.error! }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "repayment_added", id));
}

export async function updateEarlyRepaymentAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const planId = parseEntityId(formData, "planId");
  const repaymentId = parseEntityId(formData, "repaymentId");

  if (!id || !planId || !repaymentId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de la amortización no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  const parsed = parseEarlyRepaymentStrict(formData, planId, Date.now(), today);

  if (!parsed.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: `repayment-${repaymentId}`,
        message: parsed.error,
        values: preserveFields(formData, ["repaymentDate", "amount", "mode"]),
      }),
    );
  }

  const result = await runDatedFactAction(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020 / 0025): it reads the OLD
    // repayment date behind the seam, ripples from the earlier of the old/new date,
    // and guards the future. The action no longer pre-reads the row.
    const changes = await store.updateEarlyRepaymentAndRipple(
      repaymentId,
      {
        amountMinor: parsed.command.amountMinor,
        mode: parsed.command.mode,
        repaymentDate: parsed.command.repaymentDate,
      },
      { today },
    );

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró la amortización — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), {
        formId: `repayment-${repaymentId}`,
        message: result.error!,
      }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "repayment_saved", id));
}

export async function deleteEarlyRepaymentAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const repaymentId = parseEntityId(formData, "repaymentId");
  const planId = parseEntityId(formData, "planId");

  if (!id || !repaymentId || !planId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de la amortización no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  const result = await runActionWithStore(async (store) => {
    const guard = await requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Delete + ripple ride the debt seam (ADR 0020 / 0025): deleting a dated fact
    // recalculates from its date forward without generating (the
    // "amortizable-revision" kind — the curve no longer carries the repayment). The
    // seam reads the removed repayment's date behind the seam and guards the future;
    // the action no longer pre-reads the row.
    const changes = await store.deleteEarlyRepaymentAndRipple(repaymentId, { today });

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró la amortización — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "repayment_deleted", id));
}

export async function addBalanceAnchorAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  const today = _clock.today();
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

  const result = await runActionWithStore(async (store) => {
    const guard = await requireDebtModel(store, id, "anchorable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020), atomically; the from-date is
    // the anchor's own date.
    await store.addBalanceAnchorAndRipple(parsed.command, { today });

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "balanceAnchor", message: result.error! }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "balance_anchor_added", id));
}

export async function updateBalanceAnchorAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const anchorId = parseEntityId(formData, "anchorId");

  if (!id || !anchorId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador del saldo no encontrado.",
      }),
    );
  }

  const today = _clock.today();
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

  const result = await runActionWithStore(async (store) => {
    const guard = await requireDebtModel(store, id, "anchorable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020 / 0025): it reads the OLD
    // anchor date behind the seam, ripples from the earlier of the old/new date,
    // and guards the future. The action no longer pre-reads the row.
    const changes = await store.updateBalanceAnchorAndRipple(
      anchorId,
      {
        anchorDate: parsed.command.anchorDate,
        balanceMinor: parsed.command.balanceMinor,
      },
      { today },
    );

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró el saldo — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  }, _store);

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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));
  const id = parseEntityId(formData);
  const anchorId = parseEntityId(formData, "anchorId");

  if (!id || !anchorId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador del saldo no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  const result = await runActionWithStore(async (store) => {
    const guard = await requireDebtModel(store, id, "anchorable");

    if (!guard.ok) {
      return guard;
    }

    // Delete + ripple ride the debt seam (ADR 0020 / 0025): it reads the removed
    // anchor's date behind the seam, recalculates from it, and guards the future.
    // The action no longer pre-reads the row.
    const changes = await store.deleteBalanceAnchorAndRipple(anchorId, { today });

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró el saldo — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "balance_anchor_deleted", id));
}

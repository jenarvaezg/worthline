"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
import {
  assertNotInvestmentAsset,
  checkOwnershipSplit,
  isHousingAsset,
  isValueUpdateEligible,
  systemClock,
  type Clock,
} from "@worthline/domain";
import { redirect } from "next/navigation";

import {
  appendParam,
  errorRedirectUrl,
  mapDomainViolation,
  parseAppreciationRateStrict,
  parseEntityId,
  parseMoneyMinorField,
  parseOwnership,
  parseValuationAnchorStrict,
  parseAmortizationPlanStrict,
  parseBalanceAnchorStrict,
  parseDebtModelStrict,
  parseEarlyRepaymentStrict,
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

export async function deleteAssetAction(
  formData: FormData,
  _store?: WorthlineStore,
  _clock: Clock = systemClock(),
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

  const changes = runWith((store) => store.assets.softDeleteAsset(id, _clock.now()));

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
  _clock: Clock = systemClock(),
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
    store.liabilities.softDeleteLiability(id, _clock.now()),
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
    if (asset?.type === "real_estate") {
      // Full atomic seam (ADR 0020): updateAssetValuation + upsert-today-anchor
      // + ripple all behind one transaction; from-date derived inside the seam.
      store.recordHousingValuationAndRipple(id, currentValue);
    } else {
      store.assets.updateAssetValuation(id, currentValue);
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
    const derivedIds = new Set(
      allAssets.filter((a) => !isValueUpdateEligible(a)).map((a) => a.id),
    );
    const manualAssets = allAssets.filter(isValueUpdateEligible);
    const liabilities = store.liabilities.readLiabilities();

    // Reject submissions that name a derived holding (investment or connected-source
    // coin collection) — their value is computed from sub-detail, never hand-set.
    for (const [key] of formData.entries()) {
      if (!key.startsWith("val_")) continue;
      const assetId = key.slice(4);
      if (derivedIds.has(assetId)) {
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

      const liabilityType =
        formData.get("type") === "debt" ? ("debt" as const) : ("mortgage" as const);
      const associatedAssetId =
        String(formData.get("associatedAssetId") ?? "").trim() || null;

      // #171: a debt associated to a co-owned home mirrors the asset's split,
      // which may be a known partial (e.g. 75% mine, 25% a non-member's). So a
      // debt on a real_estate asset accepts a partial split, exactly like the
      // asset; a standalone debt still totals 100%.
      const associatedAsset = associatedAssetId
        ? (store.assets.readAssets().find((a) => a.id === associatedAssetId) ?? null)
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
      store.updateLiabilityAndRippleOwnership(id, {
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

    // #172 / ADR 0020: an ownership-split change ripples per-member snapshot
    // history. The ownership seam folds the persist + the conditional scope-axis
    // ripple into one atomic call; for a real_estate asset it dispatches to the
    // housing curve ripple, which already re-weights every affected snapshot from
    // the asset's new split. The previous split is captured behind the seam.
    store.updateAssetAndRippleOwnership(id, {
      name,
      type,
      liquidityTier,
      isPrimaryResidence,
      ownership,
    });

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
 * any other type is rejected with a Spanish message. After every past-dated
 * mutation the seam ripples historical snapshots so /historico reflects the
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

  const result = runWith((store) => {
    const asset = findAsset(store, id);

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
    store.setAnnualAppreciationRateAndRipple(id, parsed.rate);

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
  _clock: Clock = systemClock(),
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

  const result = runWith((store) => {
    const asset = findAsset(store, id);

    if (!asset) {
      return { ok: false, error: "No se encontró el activo." };
    }

    if (!isHousingAsset(asset)) {
      return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
    }

    // Persist + ripple ride the valuation seam (ADR 0020), atomically.
    store.addValuationAnchorAndRipple(parsed.command, { today });

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
  _clock: Clock = systemClock(),
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

  const result = runWith((store) => {
    const asset = findAsset(store, id);

    if (!asset || !isHousingAsset(asset)) {
      return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
    }

    // Persist + ripple ride the valuation seam (ADR 0020): it reads the previous
    // anchor, ripples from the earlier of the old/new date, and guards the
    // future, all atomically.
    const changes = store.updateValuationAnchorAndRipple(
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
  _clock: Clock = systemClock(),
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

  const today = _clock.today();
  const result = runWith((store) => {
    const asset = findAsset(store, id);

    if (!asset || !isHousingAsset(asset)) {
      return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
    }

    // Delete + ripple ride the valuation seam (ADR 0020): it captures the deleted
    // anchor's date behind the seam and guards the future, atomically.
    const changes = store.deleteValuationAnchorAndRipple(anchorId, { today });

    if (changes === 0) {
      return {
        ok: false,
        error: "No se encontró la tasación — puede que ya se haya eliminado.",
      };
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
  _clock: Clock = systemClock(),
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

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    const existing = store.liabilities.readAmortizationPlan(id);

    // Persist + ripple ride the debt seam (ADR 0020), atomically; the
    // amortizable-plan ripple derives its per-cuota date series behind the seam.
    if (existing) {
      store.updateAmortizationPlanAndRipple(
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
      store.createAmortizationPlanAndRipple(parsed.command, { today });
    }

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
  _clock: Clock = systemClock(),
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

  const today = _clock.today();
  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Delete + ripple ride the debt seam (ADR 0020): it captures the plan's
    // disbursement date BEFORE deleting (the floor for the planless ripple,
    // ADR 0019 #188), then recalculates every snapshot ≥ that floor against the
    // now-planless curve (the amortizable-revision kind, which falls back to
    // currentBalance), all atomically. `planId` selects the row; the liability is
    // resolved from `id`.
    const changes = store.deleteAmortizationPlanAndRipple({
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
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "plan_deleted", id));
}

export async function addInterestRateRevisionAction(
  formData: FormData,
  _store?: WorthlineStore,
  _clock: Clock = systemClock(),
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

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020); the future guard moves
    // behind the seam.
    store.addInterestRateRevisionAndRipple(parsed.command, { liabilityId: id, today });

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
  _clock: Clock = systemClock(),
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

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020): it ripples from the earlier
    // of the old/new date and guards the future. The previous revision date is
    // read here and passed in (defaulting to the new date when the row is gone).
    const previous = store.liabilities
      .readInterestRateRevisions(planId)
      .find((r) => r.id === revisionId);
    const changes = store.updateInterestRateRevisionAndRipple(
      revisionId,
      {
        newAnnualInterestRate: parsed.command.newAnnualInterestRate,
        revisionDate: parsed.command.revisionDate,
      },
      {
        liabilityId: id,
        previousRevisionDate: previous?.revisionDate ?? parsed.command.revisionDate,
        today,
      },
    );

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró la revisión — puede que ya se haya eliminado.",
      };
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
  _clock: Clock = systemClock(),
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

  const today = _clock.today();
  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Delete + ripple ride the debt seam (ADR 0020): it recalculates from the
    // removed revision's date and guards the future. A not-found delete (the row
    // is gone) ripples nothing — passing the read date keeps that guard intact.
    const removed = store.liabilities
      .readInterestRateRevisions(planId)
      .find((r) => r.id === revisionId);
    const changes = store.deleteInterestRateRevisionAndRipple(revisionId, {
      liabilityId: id,
      previousRevisionDate: removed?.revisionDate ?? today,
      today,
    });

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró la revisión — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "revision_deleted", id));
}

export async function addEarlyRepaymentAction(
  formData: FormData,
  _store?: WorthlineStore,
  _clock: Clock = systemClock(),
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

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020): a past repayment is a dated
    // fact that generates its own snapshot (the "amortizable-repayment" kind); the
    // future guard moves behind the seam.
    store.addEarlyRepaymentAndRipple(parsed.command, { liabilityId: id, today });

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(
      errorRedirectUrl(editUrl(id), { formId: "repayment", message: result.error! }),
    );
  }

  redirect(successRedirectUrl(editUrl(id), "repayment_added", id));
}

export async function updateEarlyRepaymentAction(
  formData: FormData,
  _store?: WorthlineStore,
  _clock: Clock = systemClock(),
): Promise<never> {
  const id = parseEntityId(formData);
  const planId = parseEntityId(formData, "planId");
  const repaymentId = parseEntityId(formData, "repaymentId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

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

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020): it ripples from the earlier
    // of the old/new date and guards the future. The previous repayment date is
    // read here and passed in (defaulting to the new date when the row is gone).
    const previous = store.liabilities
      .readEarlyRepayments(planId)
      .find((r) => r.id === repaymentId);
    const changes = store.updateEarlyRepaymentAndRipple(
      repaymentId,
      {
        amountMinor: parsed.command.amountMinor,
        mode: parsed.command.mode,
        repaymentDate: parsed.command.repaymentDate,
      },
      {
        liabilityId: id,
        previousRepaymentDate: previous?.repaymentDate ?? parsed.command.repaymentDate,
        today,
      },
    );

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró la amortización — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  });

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
  _store?: WorthlineStore,
  _clock: Clock = systemClock(),
): Promise<never> {
  const id = parseEntityId(formData);
  const repaymentId = parseEntityId(formData, "repaymentId");
  const planId = parseEntityId(formData, "planId");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id || !repaymentId || !planId) {
    redirect(
      errorRedirectUrl("/patrimonio", {
        message: "Identificador de la amortización no encontrado.",
      }),
    );
  }

  const today = _clock.today();
  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "amortizable");

    if (!guard.ok) {
      return guard;
    }

    // Delete + ripple ride the debt seam (ADR 0020): deleting a dated fact
    // recalculates from its date forward without generating (the
    // "amortizable-revision" kind — the curve no longer carries the repayment);
    // the future guard moves behind the seam.
    const removed = store.liabilities
      .readEarlyRepayments(planId)
      .find((r) => r.id === repaymentId);
    const changes = store.deleteEarlyRepaymentAndRipple(repaymentId, {
      liabilityId: id,
      previousRepaymentDate: removed?.repaymentDate ?? today,
      today,
    });

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró la amortización — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "repayment_deleted", id));
}

export async function addBalanceAnchorAction(
  formData: FormData,
  _store?: WorthlineStore,
  _clock: Clock = systemClock(),
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

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "anchorable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020), atomically; the from-date is
    // the anchor's own date.
    store.addBalanceAnchorAndRipple(parsed.command, { today });

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
  _clock: Clock = systemClock(),
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

  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "anchorable");

    if (!guard.ok) {
      return guard;
    }

    // Persist + ripple ride the debt seam (ADR 0020): it ripples from the earlier
    // of the old/new date and guards the future. The previous anchor date is read
    // here and passed in (defaulting to the new date when the row is gone).
    const previous = store.liabilities
      .readBalanceAnchors(id)
      .find((a) => a.id === anchorId);
    const changes = store.updateBalanceAnchorAndRipple(
      anchorId,
      {
        anchorDate: parsed.command.anchorDate,
        balanceMinor: parsed.command.balanceMinor,
      },
      {
        liabilityId: id,
        previousAnchorDate: previous?.anchorDate ?? parsed.command.anchorDate,
        today,
      },
    );

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró el saldo — puede que ya se haya eliminado.",
      };
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
  _clock: Clock = systemClock(),
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

  const today = _clock.today();
  const result = runWith((store) => {
    const guard = requireDebtModel(store, id, "anchorable");

    if (!guard.ok) {
      return guard;
    }

    // Delete + ripple ride the debt seam (ADR 0020): it recalculates from the
    // removed anchor's date and guards the future. The previous anchor date is
    // read here and passed in (defaulting to today when the row is gone).
    const removed = store.liabilities
      .readBalanceAnchors(id)
      .find((a) => a.id === anchorId);
    const changes = store.deleteBalanceAnchorAndRipple(anchorId, {
      liabilityId: id,
      previousAnchorDate: removed?.anchorDate ?? today,
      today,
    });

    if (changes === 0) {
      return {
        ok: false as const,
        error: "No se encontró el saldo — puede que ya se haya eliminado.",
      };
    }

    return { ok: true as const };
  });

  if (!result.ok) {
    redirect(errorRedirectUrl(editUrl(id), { message: result.error! }));
  }

  redirect(successRedirectUrl(editUrl(id), "balance_anchor_deleted", id));
}

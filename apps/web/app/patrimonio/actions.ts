"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
import {
  checkOwnershipSplit,
  createManualAssetSafe,
  createLiabilitySafe,
} from "@worthline/domain";
import { redirect } from "next/navigation";

import {
  appendParam,
  errorRedirectUrl,
  mapDomainViolation,
  parseAssetCommandStrict,
  parseEntityId,
  parseMoneyMinorField,
  parseOwnership,
  parseLiabilityCommand,
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

    const domainResult = createManualAssetSafe(workspace, parsed.command);

    if (!domainResult.ok) {
      return { ok: false, error: mapDomainViolation(domainResult.violations[0]) };
    }

    store.assets.createManualAsset(parsed.command);

    return { ok: true, id: parsed.command.id };
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

  const changes = runWith((store) => store.assets.softDeleteAsset(id, new Date().toISOString()));

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

  const assetType = runWith((store) => {
    const assets = store.assets.readAssets();
    return assets.find((a) => a.id === id)?.type ?? null;
  });

  if (assetType === "investment") {
    redirect(
      errorRedirectUrl(`/patrimonio/${id}/editar`, {
        formId: "edit",
        message: mapDomainViolation({ code: "investment_manual_valuation_rejected" }),
        values: preserveFields(formData, ["currentValue"]),
      }),
    );
  }

  runWith((store) => store.assets.updateAssetValuation(id, currentValue));
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

    const ownership = parseOwnership(formData, workspace.members);
    const splitViolation = checkOwnershipSplit(workspace, ownership);

    if (splitViolation) {
      return { ok: false, error: mapDomainViolation(splitViolation) };
    }

    store.assets.updateAsset(id, { name, type, liquidityTier, isPrimaryResidence, ownership });

    return { ok: true };
  });

  if (!result.ok) {
    redirect(editErrorUrl(result.error!));
  }

  redirect(successRedirectUrl("/patrimonio", "saved", id));
}

function parseAssetType(value: FormDataEntryValue | null) {
  if (value === "real_estate") return "real_estate" as const;
  if (value === "manual") return "manual" as const;
  return "cash" as const;
}

function parseLiquidityTier(value: FormDataEntryValue | null) {
  if (
    value === "market" ||
    value === "retirement" ||
    value === "illiquid" ||
    value === "housing"
  ) {
    return value;
  }
  return "cash" as const;
}

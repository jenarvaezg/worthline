"use server";

import { withStore } from "@worthline/db";
import { redirect } from "next/navigation";

import {
  appendParam,
  errorRedirectUrl,
  parseAssetCommandStrict,
  parseEntityId,
  parseMoneyMinorField,
  parseOwnership,
  parseLiabilityCommand,
  parseValueUpdatePass,
  preserveFields,
  successRedirectUrl,
  validateOwnershipSharesStrict,
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

export async function createAssetAction(formData: FormData): Promise<never> {
  const returnUrl = baseUrl(formData);

  const assetErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "asset",
      message,
      values: preserveFields(formData, ASSET_FORM_FIELDS, ["owner_"]),
    });

  const result = withStore((store) => {
    const workspace = store.readWorkspace();

    if (!workspace) {
      return { ok: false, error: "Workspace no inicializado." };
    }

    const parsed = parseAssetCommandStrict(formData, workspace.members, Date.now());

    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    const ownershipError = validateOwnershipSharesStrict(parsed.command.ownership);

    if (ownershipError) {
      return { ok: false, error: ownershipError };
    }

    store.createManualAsset(parsed.command);

    return { ok: true, id: parsed.command.id };
  });

  if (!result.ok) {
    redirect(assetErrorUrl(result.error!));
  }

  redirect(successRedirectUrl("/patrimonio", "asset_added", result.id!));
}

export async function createLiabilityAction(formData: FormData): Promise<never> {
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

  const result = withStore((store) => {
    const workspace = store.readWorkspace();

    if (!workspace) {
      return { ok: false, error: "Workspace no inicializado." };
    }

    const command = parseLiabilityCommand(formData, workspace.members, Date.now());
    const ownershipError = validateOwnershipSharesStrict(command.ownership);

    if (ownershipError) {
      return { ok: false, error: ownershipError };
    }

    store.createLiability(command);

    return { ok: true, id: command.id };
  });

  if (!result.ok) {
    redirect(liabilityErrorUrl(result.error!));
  }

  redirect(successRedirectUrl("/patrimonio", "liability_added", result.id!));
}

export async function deleteAssetAction(formData: FormData): Promise<never> {
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  withStore((store) => store.softDeleteAsset(id, new Date().toISOString()));
  redirect(successRedirectUrl("/patrimonio", "deleted_recoverable"));
}

export async function deleteLiabilityAction(formData: FormData): Promise<never> {
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  withStore((store) => store.softDeleteLiability(id, new Date().toISOString()));
  redirect(successRedirectUrl("/patrimonio", "deleted_recoverable"));
}

export async function restoreAssetAction(formData: FormData): Promise<never> {
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  withStore((store) => store.restoreAsset(id));
  redirect(successRedirectUrl("/patrimonio", "restored", id));
}

export async function restoreLiabilityAction(formData: FormData): Promise<never> {
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  withStore((store) => store.restoreLiability(id));
  redirect(successRedirectUrl("/patrimonio", "restored", id));
}

export async function acknowledgeWarningAction(formData: FormData): Promise<never> {
  const code = String(formData.get("code") ?? "").trim();
  const entityId = parseEntityId(formData, "entityId");

  if (!code || !entityId) {
    redirect(
      errorRedirectUrl(baseUrl(formData), {
        message: "No se pudo registrar el reconocimiento del aviso.",
      }),
    );
  }

  withStore((store) => store.acknowledgeWarning(code, entityId));
  redirect(successRedirectUrl("/patrimonio", "warning_acknowledged", entityId));
}

export async function updateAssetValuationAction(formData: FormData): Promise<never> {
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
      errorRedirectUrl("/patrimonio/actualizar", {
        formId: id,
        message: "El valor del activo no es válido.",
        values: preserveFields(formData, ["currentValue"]),
      }),
    );
  }

  withStore((store) => store.updateAssetValuation(id, currentValue));
  redirect(successRedirectUrl("/patrimonio", "saved", id));
}

export async function updateLiabilityBalanceAction(formData: FormData): Promise<never> {
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
      errorRedirectUrl("/patrimonio/actualizar", {
        formId: id,
        message: "El saldo de la deuda no es válido.",
        values: preserveFields(formData, ["balance"]),
      }),
    );
  }

  withStore((store) => store.updateLiabilityBalance(id, balance));
  redirect(successRedirectUrl("/patrimonio", "saved", id));
}

export async function batchValueUpdateAction(formData: FormData): Promise<never> {
  const result = withStore((store) => {
    const assets = store.readAssets().filter((a) => a.type !== "investment");
    const liabilities = store.readLiabilities();

    // Parse assets
    const assetCommands = parseValueUpdatePass(
      formData,
      assets.map((a) => ({ id: a.id, currentValueMinor: a.currentValue.amountMinor })),
    );
    const liabilityCommands = parseValueUpdatePass(
      formData,
      liabilities.map((l) => ({
        id: l.id,
        currentValueMinor: l.currentBalance.amountMinor,
      })),
    );

    const allCommands = [...assetCommands, ...liabilityCommands];
    const errors = allCommands.filter((cmd): cmd is { id: string; error: string } =>
      "error" in cmd,
    );

    if (errors.length > 0) {
      return { ok: false, error: errors[0]!.error };
    }

    const valid = allCommands.filter(
      (cmd): cmd is { id: string; newValueMinor: number } => "newValueMinor" in cmd,
    );
    const assetUpdates = valid.filter((cmd) => assets.some((a) => a.id === cmd.id));
    const liabilityUpdates = valid.filter((cmd) => liabilities.some((l) => l.id === cmd.id));

    store.batchApplyValueUpdates(assetUpdates);

    for (const cmd of liabilityUpdates) {
      store.updateLiabilityBalance(cmd.id, cmd.newValueMinor);
    }

    return { ok: true, count: valid.length };
  });

  if (!result.ok) {
    redirect(
      errorRedirectUrl("/patrimonio/actualizar", {
        message: result.error ?? "Error al actualizar valores.",
      }),
    );
  }

  redirect(appendParam("/patrimonio", "ok", result.count === 0 ? "saved" : "valores_actualizados"));
}

export async function editAssetAction(formData: FormData): Promise<never> {
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
      values: preserveFields(formData, [...EDIT_ASSET_FIELDS, "type", "associatedAssetId"], [
        "owner_",
      ]),
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
    const result = withStore((store) => {
      const workspace = store.readWorkspace();

      if (!workspace) {
        return { ok: false, error: "Workspace no inicializado." };
      }

      const ownership = parseOwnership(formData, workspace.members);
      const ownershipError = validateOwnershipSharesStrict(ownership);

      if (ownershipError) {
        return { ok: false, error: ownershipError };
      }

      const liabilityType =
        formData.get("type") === "debt" ? ("debt" as const) : ("mortgage" as const);
      const associatedAssetId = String(formData.get("associatedAssetId") ?? "").trim() || null;

      store.updateLiability(id, { name, type: liabilityType, associatedAssetId, ownership });

      return { ok: true };
    });

    if (!result.ok) {
      redirect(editErrorUrl(result.error!));
    }

    redirect(successRedirectUrl("/patrimonio", "saved", id));
  }

  const result = withStore((store) => {
    const workspace = store.readWorkspace();

    if (!workspace) {
      return { ok: false, error: "Workspace no inicializado." };
    }

    const type = parseAssetType(formData.get("type"));
    const liquidityTier = parseLiquidityTier(formData.get("liquidityTier"));
    const isPrimaryResidence = formData.get("isPrimaryResidence") === "on";

    const ownership = parseOwnership(formData, workspace.members);
    const ownershipError = validateOwnershipSharesStrict(ownership);

    if (ownershipError) {
      return { ok: false, error: ownershipError };
    }

    store.updateAsset(id, { name, type, liquidityTier, isPrimaryResidence, ownership });

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

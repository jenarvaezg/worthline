"use server";

import { formAction } from "@web/form-action";
import {
  errorRedirectUrl,
  mapDomainViolation,
  parseEntityId,
  parseOwnership,
  successRedirectUrl,
} from "@web/intake";
import {
  executeUpdateAssetOwnershipSplitCommand,
  executeUpdateLiabilityOwnershipSplitCommand,
} from "@worthline/db";
import { checkSinglePrimaryResidence } from "@worthline/domain";
import {
  baseUrl,
  editAssetErrorUrl,
  mapOwnershipSplitCommandResult,
  parseAssetType,
  parseLiquidityTier,
} from "./action-helpers";

export async function deleteAssetAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    missingIdUrl: baseUrl,
    run: async (store, { id, now }) => {
      const changes = await store.assets.softDeleteAsset(id, now);
      return changes === 0
        ? {
            ok: false,
            error: "No se encontró el elemento — puede que ya haya sido eliminado.",
          }
        : { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/patrimonio", "deleted_recoverable"),
  })(formData, ..._testArgs);
}

export async function deleteLiabilityAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de deuda no encontrado.",
    missingIdUrl: baseUrl,
    run: async (store, { id, now }) => {
      const changes = await store.liabilities.softDeleteLiability(id, now);
      return changes === 0
        ? {
            ok: false,
            error: "No se encontró el elemento — puede que ya haya sido eliminado.",
          }
        : { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/patrimonio", "deleted_recoverable"),
  })(formData, ..._testArgs);
}

export async function hardDeleteAssetAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    missingIdUrl: baseUrl,
    run: async (store, { id }) => {
      const changes = await store.assets.hardDeleteAsset(id);
      return changes === 0
        ? { ok: false, error: "No se encontró el elemento en la papelera." }
        : { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/patrimonio", "hard_deleted"),
  })(formData, ..._testArgs);
}

export async function hardDeleteLiabilityAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de deuda no encontrado.",
    missingIdUrl: baseUrl,
    run: async (store, { id }) => {
      const changes = await store.liabilities.hardDeleteLiability(id);
      return changes === 0
        ? { ok: false, error: "No se encontró el elemento en la papelera." }
        : { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/patrimonio", "hard_deleted"),
  })(formData, ..._testArgs);
}

export async function emptyTrashAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    requireId: false,
    datedFact: false,
    run: async (store) => {
      await store.emptyTrash();
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: () => successRedirectUrl("/patrimonio", "trash_emptied"),
  })(formData, ..._testArgs);
}

export async function restoreAssetAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    missingIdUrl: baseUrl,
    run: async (store, { id }) => {
      const changes = await store.assets.restoreAsset(id);
      return changes === 0
        ? {
            ok: false,
            error: "No se encontró el elemento — puede que ya no esté en papelera.",
          }
        : { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: ({ id }) => successRedirectUrl("/patrimonio", "restored", id),
  })(formData, ..._testArgs);
}

export async function restoreLiabilityAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de deuda no encontrado.",
    missingIdUrl: baseUrl,
    run: async (store, { id }) => {
      const changes = await store.liabilities.restoreLiability(id);
      return changes === 0
        ? {
            ok: false,
            error: "No se encontró el elemento — puede que ya no esté en papelera.",
          }
        : { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: ({ id }) => successRedirectUrl("/patrimonio", "restored", id),
  })(formData, ..._testArgs);
}

export async function acknowledgeWarningAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ code: string; entityId: string }, { entityId: string }>({
    requireId: false,
    datedFact: false,
    parse: ({ formData }) => {
      const code = String(formData.get("code") ?? "").trim();
      const entityId = parseEntityId(formData, "entityId");
      if (!code || !entityId) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            message: "No se pudo registrar el reconocimiento del aviso.",
          }),
        };
      }
      return { ok: true, value: { code, entityId } };
    },
    run: async (store, { parsed }) => {
      await store.acknowledgeWarning(parsed.code, parsed.entityId);
      return { ok: true, value: { entityId: parsed.entityId } };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: ({ value }) =>
      successRedirectUrl("/patrimonio", "warning_acknowledged", value?.entityId),
  })(formData, ..._testArgs);
}

export async function editAssetAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ name: string; isLiability: boolean }>({
    datedFact: false,
    missingId: "Identificador no encontrado.",
    parse: ({ formData, id }) => {
      const isLiability = formData.get("isLiability") === "true";
      const name = String(formData.get("name") ?? "").trim();
      if (!name) {
        return {
          ok: false,
          redirect: editAssetErrorUrl(
            id,
            formData,
            isLiability
              ? "El nombre de la deuda es obligatorio."
              : "El nombre del activo es obligatorio.",
          ),
        };
      }
      return { ok: true, value: { name, isLiability } };
    },
    run: async (store, { id, formData, parsed: { name, isLiability } }) => {
      const workspace = await store.workspace.readWorkspace();
      if (!workspace) {
        return { ok: false, error: "Workspace no inicializado." };
      }

      if (isLiability) {
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

        const commandResult = await executeUpdateLiabilityOwnershipSplitCommand(store, {
          liabilityId: id,
          allowKnownPartial,
          patch: { name, type: liabilityType, associatedAssetId, ownership },
        });
        return mapOwnershipSplitCommandResult(commandResult);
      }

      const type = parseAssetType(formData.get("type"));
      const liquidityTier = parseLiquidityTier(formData.get("liquidityTier"));
      const isPrimaryResidence = formData.get("isPrimaryResidence") === "on";

      const ownership = parseOwnership(formData, workspace.members, {
        completeShortfall: type !== "real_estate",
      });

      if (isPrimaryResidence) {
        const primaryViolation = checkSinglePrimaryResidence(
          await store.assets.readAssets(),
          { assetId: id, isPrimaryResidence },
        );
        if (primaryViolation) {
          return { ok: false, error: mapDomainViolation(primaryViolation) };
        }
      }

      const commandResult = await executeUpdateAssetOwnershipSplitCommand(store, {
        assetId: id,
        allowKnownPartial: type === "real_estate",
        patch: { name, type, liquidityTier, isPrimaryResidence, ownership },
      });
      return mapOwnershipSplitCommandResult(commandResult);
    },
    onError: ({ id, formData, error }) => editAssetErrorUrl(id, formData, error),
    onSuccess: ({ id }) => successRedirectUrl("/patrimonio", "saved", id),
  })(formData, ..._testArgs);
}

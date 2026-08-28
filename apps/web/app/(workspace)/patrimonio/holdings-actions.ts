"use server";

import { testFxRatesOverride } from "@web/action-store";
import { formAction } from "@web/form-action";
import {
  createStableId,
  errorRedirectUrl,
  mapDomainViolation,
  parseEntityId,
  parseOwnership,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import type { WorthlineStore } from "@web/store";
import {
  executeUpdateAssetOwnershipSplitCommand,
  executeUpdateLiabilityOwnershipSplitCommand,
} from "@worthline/db";
import type { TrashExit } from "@worthline/domain";
import {
  checkSinglePrimaryResidence,
  createInvestmentOperationSafe,
  netUnitsFromOperations,
  parseTrashExit,
} from "@worthline/domain";
import { convertCapturedOperation } from "@worthline/pricing";

import {
  parseTrashSaleForm,
  TRASH_EXIT_FORM_FIELDS,
  TRASH_FORM_ID,
  trashRefusalMessage,
} from "./[id]/editar/_surfaces/trash-exit-form";
import {
  baseUrl,
  boardAnchorResult,
  editAssetErrorUrl,
  holdingBoardAnchor,
  mapOwnershipSplitCommandResult,
  parseAssetType,
  parseLiquidityTier,
  withBoardAnchor,
} from "./action-helpers";

/**
 * The Papelera door (#1549, ADR 0085). Archiving a holding with money still inside
 * is not a cosmetic gesture — it is how 7.642 € left a real patrimonio with no sale,
 * no traspaso and no deposit recorded anywhere (#1365, Groupama). So the door asks
 * where the money went, and this action is the two exits that end in an archive:
 *
 * - **«Lo vendí»** records the closing sale FIRST, through the ordinary operation
 *   command — same ripple, same snapshots as a sale typed on the ficha — and then
 *   archives a position that is now empty. The sale is written and rippled BEFORE
 *   the archive and outside its transaction: if the archive then fails, the book
 *   holds a recorded sale on a live holding — visible, editable, and never money
 *   that left without a trace, which is the one failure this door must not have.
 * - **«Fue un error de registro»** archives with the value still inside, and says so
 *   on the row: the only declaration that unlocks the gate, because it is the only
 *   one that claims the money was never there.
 *
 * The third exit, «Lo traspasé a…», does not pass through here: a traspaso enters
 * and leaves the book by ONE door (ADR 0083), the Traspasar surface of this same
 * ficha, which archives the origin itself when it is left empty. Duplicating a
 * second half-traspaso inside the danger zone is exactly the two-engines mistake
 * #1438 measured.
 *
 * The refusal itself is NOT enforced here but in `softDeleteAsset`, because the
 * assistant writes below the web's guards (#1468) — this action only turns the
 * store's verdict into a sentence.
 */
export async function deleteAssetAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<TrashExit | null, string>({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    missingIdUrl: baseUrl,
    parse: ({ formData }) => ({ ok: true, value: parseTrashExit(formData.get("exit")) }),
    run: async (store, { formData, id, now, parsed: exit, today }) => {
      if (exit === "sold") {
        const recorded = await recordClosingSale(store, {
          assetId: id,
          soldAmount: String(formData.get("soldAmount") ?? ""),
          soldAt: String(formData.get("soldAt") ?? ""),
          testArgs: _testArgs,
          today,
        });
        if (!recorded.ok) return recorded;
      }

      const outcome = await store.assets.softDeleteAsset(id, now, exit);
      switch (outcome.status) {
        case "deleted":
          return { ok: true };
        case "not_found":
          return {
            ok: false,
            error: "No se encontró el elemento — puede que ya haya sido eliminado.",
          };
        case "refused":
          return { ok: false, error: trashRefusalMessage(outcome.refusal) };
      }
    },
    // A refused exit round-trips what was typed AND which exit was chosen (#1329):
    // the door lives inside a `<details>` the user has to open, and losing the
    // importe he just copied off the bank's confirmation is the friction that sends
    // him back to deleting the holding in silence.
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), {
        formId: TRASH_FORM_ID,
        message: error,
        values: preserveFields(formData, [...TRASH_EXIT_FORM_FIELDS]),
      }),
    onSuccess: () => successRedirectUrl("/patrimonio", "deleted_recoverable"),
  })(formData, ..._testArgs);
}

/**
 * The closing sale of the «Lo vendí» exit: every participación the ledger still
 * holds, at the importe the owner states over them.
 *
 * It goes through `createInvestmentOperationSafe` and `recordInvestmentOperation`
 * — the same gate and the same ripple as a sale typed on the ficha — and it is
 * converted to euros first when the ledger is not in euros (#1401), exactly as
 * `recordOperationAction` does. Nothing about this exit is a shortcut around the
 * operation path; it is that path, reached from the door that needed it.
 */
async function recordClosingSale(
  store: WorthlineStore,
  params: {
    assetId: string;
    soldAmount: string;
    soldAt: string;
    testArgs: readonly unknown[];
    today: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const asset = (await store.assets.readAssets()).find(
    (candidate) => candidate.id === params.assetId,
  );
  if (!asset) {
    return { ok: false, error: "Ese activo ya no está en tu patrimonio." };
  }

  const operations = await store.operations.readOperations(params.assetId);
  const parsed = parseTrashSaleForm(
    { soldAmount: params.soldAmount, soldAt: params.soldAt },
    {
      currency: asset.currency,
      netUnits: netUnitsFromOperations(operations),
      today: params.today,
    },
  );
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const domainResult = createInvestmentOperationSafe({
    assetId: params.assetId,
    currency: parsed.command.currency,
    executedAt: parsed.command.executedAt,
    feesMinor: 0,
    id: createStableId("op", `${params.assetId}_trash_sale`, Date.now()),
    kind: "sell",
    pricePerUnit: parsed.command.pricePerUnit,
    units: parsed.command.units,
  });
  if (!domainResult.ok) {
    return { ok: false, error: mapDomainViolation(domainResult.violations[0]) };
  }

  const converted = await convertCapturedOperation(
    domainResult.value,
    testFxRatesOverride(params.testArgs),
  );
  if (!converted.ok) {
    return { ok: false, error: mapDomainViolation(converted.violations[0]) };
  }

  await store.command.recordInvestmentOperation(converted.value, {
    today: params.today,
  });
  return { ok: true };
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
        : boardAnchorResult(await holdingBoardAnchor(store, id));
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: ({ value }) => successRedirectUrl("/patrimonio", "restored", value),
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
        : boardAnchorResult(await holdingBoardAnchor(store, id));
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: ({ value }) => successRedirectUrl("/patrimonio", "restored", value),
  })(formData, ..._testArgs);
}

export async function acknowledgeWarningAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ code: string; entityId: string }, string>({
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
      return boardAnchorResult(await holdingBoardAnchor(store, parsed.entityId));
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: ({ value }) =>
      successRedirectUrl("/patrimonio", "warning_acknowledged", value),
  })(formData, ..._testArgs);
}

export async function editAssetAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ name: string; isLiability: boolean }, string>({
    datedFact: false,
    missingId: "Identificador no encontrado.",
    parse: ({ formData }) => {
      const isLiability = formData.get("isLiability") === "true";
      const name = String(formData.get("name") ?? "").trim();
      if (!name) {
        return {
          ok: false,
          redirect: editAssetErrorUrl(
            formData,
            isLiability
              ? "El nombre de la deuda es obligatorio."
              : "El nombre del activo es obligatorio.",
          ),
        };
      }
      return { ok: true, value: { name, isLiability } };
    },
    run: async (store, { id, formData, today, parsed: { name, isLiability } }) => {
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
        return withBoardAnchor(store, id, mapOwnershipSplitCommandResult(commandResult));
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
        today,
      });
      return withBoardAnchor(store, id, mapOwnershipSplitCommandResult(commandResult));
    },
    onError: ({ formData, error }) => editAssetErrorUrl(formData, error),
    onSuccess: ({ value }) => successRedirectUrl("/patrimonio", "saved", value),
  })(formData, ..._testArgs);
}

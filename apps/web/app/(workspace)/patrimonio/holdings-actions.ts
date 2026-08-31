"use server";

import { testFxRatesOverride } from "@web/action-store";
import { formAction } from "@web/form-action";
import {
  createStableId,
  errorRedirectUrl,
  mapDomainViolation,
  parseAvailableFromStrict,
  parseContributionLot,
  parseEntityId,
  parseOwnership,
  preserveFields,
  proposeLadderFromLedger,
  successRedirectUrl,
} from "@web/intake";
import type { WorthlineStore } from "@web/store";
import {
  executeUpdateAssetOwnershipSplitCommand,
  executeUpdateLiabilityOwnershipSplitCommand,
} from "@worthline/db";
import type { Instrument, ManualAsset, TrashExit } from "@worthline/domain";
import {
  checkSinglePrimaryResidence,
  createInvestmentOperationSafe,
  defaultsFor,
  instrumentLabelEs,
  instrumentOfAsset,
  isAssignableInstrument,
  isInstrument,
  keepsKnownPartialOwnership,
  netUnitsFromOperations,
  ownershipShortfallOnCorrection,
  parseTrashExit,
  readLedgerSeniority,
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
  findAsset,
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

      const assets = await store.assets.readAssets();
      const current = assets.find((asset) => asset.id === id) ?? null;
      if (!current) {
        return { ok: false, error: "No se encontró el activo." };
      }

      // #1512: «Lo básico» now edits the INSTRUMENT, not the legacy AssetType —
      // the type is derived from it in the store. A form that posts no instrument
      // (the connected-source surfaces, which lock the identity) keeps the old
      // type-first path untouched.
      const parsedInstrument = parseCorrectedInstrument(formData, current);
      if (!parsedInstrument.ok) {
        return { ok: false, error: parsedInstrument.error };
      }
      const instrument = parsedInstrument.instrument;
      const type = instrument
        ? (defaultsFor(instrument).assetType ?? current.type)
        : parseAssetType(formData.get("type"));
      const liquidityTier = parseLiquidityTier(formData.get("liquidityTier"));
      // The one spelling of the known-partial rule (#171/#241): a holding whose
      // split may total under 100 % is an inmueble and nothing else. It decides
      // both whether the save completes the shortfall and whether the command
      // accepts the result.
      const keepsPartialOwnership = instrument
        ? keepsKnownPartialOwnership(instrument)
        : type === "real_estate";
      // A non-`property` instrument cannot be anybody's habitual residence, and
      // leaving the flag set would let the next type edit re-derive `property` and
      // undo the correction (the store force-clears it for the same reason).
      const isPrimaryResidence =
        instrument && instrument !== "property"
          ? false
          : formData.get("isPrimaryResidence") === "on";

      // The split AS TYPED — what the guard below has to judge. Reading the stored
      // ownership instead would both miss a partial arriving in THIS submit and
      // block the legitimate save that fixes the titularidad and the instrument
      // together.
      const enteredOwnership = parseOwnership(formData, workspace.members, {
        completeShortfall: false,
      });
      if (instrument) {
        const shortfallBps = ownershipShortfallOnCorrection({
          enteredBps: totalShareBps(enteredOwnership),
          to: instrument,
        });
        if (shortfallBps > 0) {
          return { ok: false, error: partialOwnershipRefusal(instrument, shortfallBps) };
        }
      }
      const ownership = keepsPartialOwnership
        ? enteredOwnership
        : parseOwnership(formData, workspace.members, {});

      if (isPrimaryResidence) {
        const primaryViolation = checkSinglePrimaryResidence(assets, {
          assetId: id,
          isPrimaryResidence,
        });
        if (primaryViolation) {
          return { ok: false, error: mapDomainViolation(primaryViolation) };
        }
      }

      const commandResult = await executeUpdateAssetOwnershipSplitCommand(store, {
        assetId: id,
        allowKnownPartial: keepsPartialOwnership,
        patch: {
          liquidityTier,
          isPrimaryResidence,
          name,
          ownership,
          // Exactly one of the two axes travels: the instrument when the form
          // corrected it (the store derives `type` from it), the legacy `type`
          // otherwise — the path the connected-source surfaces still post on.
          // `exactOptionalPropertyTypes` forbids passing `undefined` for either.
          ...(instrument ? { instrument } : { type }),
        },
        today,
      });
      return withBoardAnchor(store, id, mapOwnershipSplitCommandResult(commandResult));
    },
    onError: ({ formData, error }) => editAssetErrorUrl(formData, error),
    onSuccess: ({ value }) => successRedirectUrl("/patrimonio", "saved", value),
  })(formData, ..._testArgs);
}

/**
 * Declarar desde cu\u00e1ndo se puede tocar un holding a plazo (#1528, ADR 0100).
 *
 * El escal\u00f3n `term-locked` es, desde ADR 0013, \u00abbloqueado hasta una fecha\u00bb \u2014 y esa
 * fecha no exist\u00eda en el modelo, as\u00ed que un plan de pensiones se trataba como un
 * bloque todo-o-nada. Este formulario es la fecha, y solo la fecha: lo disponible se
 * deriva en lectura y no se guarda jam\u00e1s, porque un importe caduca cada a\u00f1o y una
 * fecha no (ADR 0074).
 *
 * Vac\u00edo BORRA la declaraci\u00f3n y vuelve a \u00abnadie lo ha dicho\u00bb, el estado en el que
 * empiezan todos los holdings: es el mismo contrato del coste de adquisici\u00f3n (#1441),
 * y la raz\u00f3n de que el par\u00e1metro del seam sea `string | null` y no un `string`.
 *
 * `datedFact: false`: guardar esto no escribe ning\u00fan hecho fechado ni re-deriva
 * historia. Lo \u00fanico que lo lee es el reparto del gasto sostenible de agotamiento,
 * que se recalcula entero en cada lectura.
 */
/**
 * Añadir un lote a la escalera de un holding a plazo (#1676).
 *
 * Lee la escalera actual y la reescribe entera con el lote nuevo dentro: el seam
 * reemplaza de una pieza porque una escalera ES una declaración completa, y una acción
 * incremental encima de él es lo que hace usable declararla con el extracto delante.
 *
 * `datedFact: false` por lo mismo que la fecha única: no escribe ningún hecho fechado y
 * no re-deriva historia — lo único que lee los lotes es el reparto del gasto
 * sostenible, que se recalcula entero en cada lectura.
 */
export async function addContributionLotAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ availableFrom: string; amountMinor: number }, undefined>({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    parse: ({ formData }) => {
      const parsed = parseContributionLot(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: "contributionLot",
            message: parsed.error,
            values: preserveFields(formData, ["lotAvailableFrom", "lotAmount"]),
          }),
        };
      }
      return {
        ok: true,
        value: { amountMinor: parsed.amountMinor, availableFrom: parsed.availableFrom },
      };
    },
    run: async (store, { id, parsed }) => {
      const asset = await findAsset(store, id);
      if (!asset) {
        return { ok: false, error: "No se encontr\u00f3 el activo." };
      }
      // El mismo rechazo que el seam, en las palabras del usuario.
      if (asset.liquidityTier !== "term-locked") {
        return {
          ok: false,
          error:
            "Solo un holding en el escal\u00f3n \u00abA plazo\u00bb puede declarar lotes de aportaci\u00f3n.",
        };
      }
      // El read-modify-write vive en el seam, dentro de una transacción: hacerlo aquí
      // dejaría que dos pestañas leyeran la misma escalera y una perdiera su lote.
      await store.assets.addContributionLot(id, {
        amountMinor: parsed.amountMinor,
        availableFrom: parsed.availableFrom,
      });
      return { ok: true, value: undefined };
    },
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "contributionLot", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "contribution_lot_saved"),
  })(formData, ..._testArgs);
}

/**
 * Guardar la escalera que el libro propuso (#1687).
 *
 * La propuesta se vuelve a derivar AQUÍ, del mismo ledger y con la misma función que la
 * pintó, en vez de viajar por el formulario: un importe que va y vuelve por la red es un
 * importe que se puede manipular, y sobre todo es una cifra que ya no está atada a la
 * fuente que la produjo (ADR 0077). El formulario sólo dice «sí, guarda lo que me
 * enseñaste».
 *
 * Reemplaza la escalera entera, y por eso la pantalla pide confirmación cuando ya hay
 * lotes declarados: lo que se pierde es trabajo del dueño, no un derivado.
 */
export async function applyProposedLotsAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<Record<string, never>, { lots: number }>({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    parse: () => ({ ok: true, value: {} }),
    run: async (store, { id }) => {
      const asset = await findAsset(store, id);
      if (!asset) {
        return { ok: false, error: "No se encontr\u00f3 el activo." };
      }
      if (asset.liquidityTier !== "term-locked") {
        return {
          ok: false,
          error:
            "Solo un holding en el escal\u00f3n \u00abA plazo\u00bb puede declarar lotes de aportaci\u00f3n.",
        };
      }

      const proposed = proposeLadderFromLedger(
        readLedgerSeniority(await store.operations.readOperations(id)),
      );

      if (proposed.lots.length === 0) {
        return {
          ok: false,
          error:
            "Tu libro no tiene ninguna aportaci\u00f3n con antig\u00fcedad conocida, as\u00ed que no hay escalera que proponer.",
        };
      }

      await store.assets.replaceContributionLots(id, proposed.lots);
      return { ok: true, value: { lots: proposed.lots.length } };
    },
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "contributionLot", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "contribution_lots_proposed"),
  })(formData, ..._testArgs);
}

/**
 * Quitar un lote de la escalera (#1676). Se identifica por el id que la lectura acaba
 * de dar: los ids se regeneran en cada escritura —un lote es una línea de una
 * declaración, no una entidad que nadie siga entre ediciones— así que este id vale para
 * la pantalla que lo está enseñando y para nada más.
 */
export async function removeContributionLotAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ lotId: string }, undefined>({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    parse: ({ formData }) => {
      const lotId = String(formData.get("lotId") ?? "").trim();
      if (!lotId) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: "contributionLot",
            message: "No se encontr\u00f3 el lote que quieres quitar.",
          }),
        };
      }
      return { ok: true, value: { lotId } };
    },
    run: async (store, { id, parsed }) => {
      // Un id que ya no está es una pantalla vieja, no un error del usuario: la
      // escalera ya no lo tiene, que es justo lo que él pedía. El seam lo trata así y
      // hace el read-modify-write dentro de una transacción.
      await store.assets.removeContributionLot(id, parsed.lotId);
      return { ok: true, value: undefined };
    },
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "contributionLot", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "contribution_lot_removed"),
  })(formData, ..._testArgs);
}

export async function setHoldingAvailableFromAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ availableFrom: string | null }, { cleared: boolean }>({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    parse: ({ formData }) => {
      const parsed = parseAvailableFromStrict(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: "availableFrom",
            message: parsed.error,
            values: preserveFields(formData, ["availableFrom"]),
          }),
        };
      }
      return { ok: true, value: { availableFrom: parsed.availableFrom } };
    },
    run: async (store, { id, parsed }) => {
      const asset = await findAsset(store, id);
      if (!asset) {
        return { ok: false, error: "No se encontr\u00f3 el activo." };
      }
      // El mismo rechazo que el seam, dicho aqu\u00ed en las palabras del usuario: solo el
      // escal\u00f3n que declara un plazo puede decir cu\u00e1ndo se acaba.
      if (asset.liquidityTier !== "term-locked") {
        return {
          ok: false,
          error:
            "Solo un holding en el escal\u00f3n \u00abA plazo\u00bb puede declarar desde cu\u00e1ndo est\u00e1 disponible.",
        };
      }
      await store.assets.setAvailableFrom(id, parsed.availableFrom);
      return { ok: true, value: { cleared: parsed.availableFrom === null } };
    },
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "availableFrom", message: error }),
    onSuccess: ({ value }) =>
      successRedirectUrl(
        baseUrl(formData),
        value?.cleared ? "available_from_cleared" : "available_from_saved",
      ),
  })(formData, ..._testArgs);
}

/**
 * The instrument correction «Lo básico» carries, if any (#1512, ADR 0098).
 *
 * An instrument decides how the holding is VALUED, so a correction may only move
 * it WITHIN its persistence shape (`assignableInstruments`). Handing a hand-valued
 * row a `derived` instrument would promise an operations ledger that does not
 * exist, and the ficha would then render an investment surface over nothing.
 *
 * `isInstrument` comes first: a stray string must never reach the exhaustive
 * catalog, and the refusal must not tell the user their value has some other way
 * of being valued when it has none.
 */
function parseCorrectedInstrument(
  formData: FormData,
  current: ManualAsset,
): { ok: true; instrument: Instrument | undefined } | { ok: false; error: string } {
  const raw = String(formData.get("instrument") ?? "").trim();
  if (!raw) {
    return { ok: true, instrument: undefined };
  }
  if (!isInstrument(raw) || !isAssignableInstrument(instrumentOfAsset(current), raw)) {
    return {
      ok: false,
      error: `No se puede reclasificar «${current.name}» a ese tipo: se valora de otra forma. Para eso hay que darlo de alta de nuevo.`,
    };
  }
  return { ok: true, instrument: raw };
}

/** An ownership split's declared total, in basis points. */
function totalShareBps(ownership: readonly { shareBps: number }[]): number {
  return ownership.reduce((sum, share) => sum + share.shareBps, 0);
}

/**
 * The refusal for a correction that would close an ownership shortfall on the way
 * out of `property` — the one shape whose split may total under 100 % (#171). Every
 * other instrument completes the shortfall on save, so letting this through would
 * hand the user the missing share of the value: a change of net worth dressed as a
 * change of label.
 */
function partialOwnershipRefusal(to: Instrument, shortfallBps: number): string {
  const declared = ((10_000 - shortfallBps) / 100).toFixed(2).replace(".", ",");
  return `Has declarado una titularidad parcial (${declared} %), y solo un inmueble la mantiene. En «${instrumentLabelEs(to)}» pasaría a contar al 100 %: ajusta primero la titularidad.`;
}

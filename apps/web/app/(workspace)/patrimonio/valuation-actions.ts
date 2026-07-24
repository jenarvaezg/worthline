"use server";

import { formAction } from "@web/form-action";
import {
  appendParam,
  errorRedirectUrl,
  mapDomainViolation,
  parseAppreciationRateStrict,
  parseMoneyMinorField,
  parseValuationAnchorStrict,
  parseValuationCadenceStrict,
  parseValueUpdatePass,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import {
  executeAddValuationAnchorCommand,
  executeDeleteValuationAnchorCommand,
  executeRecordHousingValuationCommand,
  executeSetAnnualAppreciationRateCommand,
  executeSetHousingValuationCadenceCommand,
  executeUpdateValuationAnchorCommand,
} from "@worthline/db";
import {
  checkManualValuationViolation,
  isHousingAsset,
  isValueUpdateEligible,
} from "@worthline/domain";
import { baseUrl, editUrl, findAsset, findLiability } from "./action-helpers";

export async function updateAssetValuationAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<number>({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    missingIdUrl: baseUrl,
    parse: ({ formData, id }) => {
      const currentValue = parseMoneyMinorField(formData, "currentValue");
      if (currentValue === null) {
        return {
          ok: false,
          redirect: errorRedirectUrl(`/patrimonio/${id}/editar`, {
            formId: "edit",
            message: "El valor del activo no es válido.",
            values: preserveFields(formData, ["currentValue"]),
          }),
        };
      }
      return { ok: true, value: currentValue };
    },
    run: async (store, { id, parsed: currentValue }) => {
      const asset = (await store.assets.readAssets()).find((a) => a.id === id) ?? null;

      // Domain guard (ADR 0006, #883/#945): derived and connected holdings must
      // never be hand-edited. Enforced before the write (PRD #120 candidate 3).
      if (asset) {
        const violation = checkManualValuationViolation(asset);
        if (violation) {
          return { ok: false, error: mapDomainViolation(violation) };
        }
      }

      if (asset?.type === "real_estate") {
        await executeRecordHousingValuationCommand(store, {
          assetId: id,
          currentValueMinor: currentValue,
        });
      } else {
        await store.assets.updateAssetValuation(id, currentValue);
      }
      return { ok: true };
    },
    onError: ({ id, formData, error }) =>
      errorRedirectUrl(`/patrimonio/${id}/editar`, {
        formId: "edit",
        message: error,
        values: preserveFields(formData, ["currentValue"]),
      }),
    onSuccess: ({ id }) => successRedirectUrl("/patrimonio", "saved", id),
  })(formData, ..._testArgs);
}

export async function updateLiabilityBalanceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<number>({
    datedFact: false,
    missingId: "Identificador de deuda no encontrado.",
    missingIdUrl: baseUrl,
    parse: ({ formData, id }) => {
      const balance = parseMoneyMinorField(formData, "balance");
      if (balance === null) {
        return {
          ok: false,
          redirect: errorRedirectUrl(`/patrimonio/${id}/editar`, {
            formId: "edit",
            message: "El saldo de la deuda no es válido.",
            values: preserveFields(formData, ["balance"]),
          }),
        };
      }
      return { ok: true, value: balance };
    },
    run: async (store, { id, parsed: balance }) => {
      await store.liabilities.updateLiabilityBalance(id, balance);
      return { ok: true };
    },
    onError: ({ id, formData, error }) =>
      errorRedirectUrl(`/patrimonio/${id}/editar`, {
        formId: "edit",
        message: error,
        values: preserveFields(formData, ["balance"]),
      }),
    onSuccess: ({ id }) => successRedirectUrl("/patrimonio", "saved", id),
  })(formData, ..._testArgs);
}

export async function batchValueUpdateAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<undefined, { count: number }>({
    requireId: false,
    datedFact: false,
    run: async (store, { formData }) => {
      const allAssets = await store.assets.readAssets();
      // The catalog seam decides who the pass hand-updates: every holding whose
      // valuation method is not derived (ADR 0014) — no inline instrument list.
      const manualAssets = allAssets.filter(isValueUpdateEligible);
      const assetsById = new Map(allAssets.map((a) => [a.id, a]));
      const liabilities = await store.liabilities.readLiabilities();

      // Reject submissions that name a derived holding (investment or connected-
      // source coin collection) — their value is computed from sub-detail, never
      // hand-set. Ask the catalog seam per submitted holding, not an inline id-set.
      for (const [key] of formData.entries()) {
        if (!key.startsWith("val_")) continue;
        const asset = assetsById.get(key.slice(4));
        if (asset && !isValueUpdateEligible(asset)) {
          const violation = checkManualValuationViolation(asset) ?? {
            code: "value_update_investment_holding" as const,
          };
          return { ok: false, error: mapDomainViolation(violation) };
        }
      }

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
      const assetUpdates = valid.filter((cmd) =>
        manualAssets.some((a) => a.id === cmd.id),
      );
      const liabilityUpdates = valid.filter((cmd) =>
        liabilities.some((l) => l.id === cmd.id),
      );

      await store.operations.batchApplyAllValueUpdates(assetUpdates, liabilityUpdates);

      return { ok: true, value: { count: valid.length } };
    },
    onError: ({ error }) =>
      errorRedirectUrl("/patrimonio/actualizar", {
        message: error || "Error al actualizar valores.",
      }),
    onSuccess: ({ value }) =>
      appendParam(
        "/patrimonio",
        "ok",
        value?.count === 0 ? "saved" : "valores_actualizados",
      ),
  })(formData, ..._testArgs);
}

export async function setAppreciationRateAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    parse: ({ formData, id }) => {
      const parsed = parseAppreciationRateStrict(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(editUrl(id), {
            formId: "rate",
            message: parsed.error,
            values: preserveFields(formData, ["rate"]),
          }),
        };
      }
      return { ok: true, value: { rate: parsed.rate } };
    },
    run: async (store, { id, parsed }) => {
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
      // Persist + from-date derivation + ripple ride the housing valuation command.
      await executeSetAnnualAppreciationRateCommand(store, {
        assetId: id,
        rate: parsed.rate,
      });
      return { ok: true };
    },
    onError: ({ id, error }) =>
      errorRedirectUrl(editUrl(id), { formId: "rate", message: error }),
    onSuccess: ({ id }) => successRedirectUrl(editUrl(id), "rate_saved", id),
  })(formData, ..._testArgs);
}

export async function addValuationAnchorAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    missingId: "Identificador de activo no encontrado.",
    parse: ({ formData, id, today }) => {
      const parsed = parseValuationAnchorStrict(formData, id, Date.now(), today);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(editUrl(id), {
            formId: "anchor",
            message: parsed.error,
            values: preserveFields(formData, [
              "valuationDate",
              "anchorValue",
              "adjustsPriorCurve",
            ]),
          }),
        };
      }
      return { ok: true, value: parsed.command };
    },
    run: async (store, { id, today, parsed }) => {
      const asset = await findAsset(store, id);
      if (!asset) {
        return { ok: false, error: "No se encontró el activo." };
      }
      if (!isHousingAsset(asset)) {
        return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
      }
      await executeAddValuationAnchorCommand(store, { input: parsed, today });
      return { ok: true };
    },
    onError: ({ id, error }) =>
      errorRedirectUrl(editUrl(id), { formId: "anchor", message: error }),
    onSuccess: ({ id }) => successRedirectUrl(editUrl(id), "anchor_added", id),
  })(formData, ..._testArgs);
}

export async function updateValuationAnchorAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    extraIds: ["anchorId"],
    missingId: "Identificador de tasación no encontrado.",
    parse: ({ formData, id, extra, today }) => {
      const parsed = parseValuationAnchorStrict(formData, id, Date.now(), today);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(editUrl(id), {
            formId: `anchor-${extra.anchorId}`,
            message: parsed.error,
            values: preserveFields(formData, [
              "valuationDate",
              "anchorValue",
              "adjustsPriorCurve",
            ]),
          }),
        };
      }
      return { ok: true, value: parsed.command };
    },
    run: async (store, { id, extra, today, parsed }) => {
      const asset = await findAsset(store, id);
      if (!asset || !isHousingAsset(asset)) {
        return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
      }
      const commandResult = await executeUpdateValuationAnchorCommand(store, {
        anchorId: extra.anchorId!,
        input: {
          adjustsPriorCurve: parsed.adjustsPriorCurve,
          valuationDate: parsed.valuationDate,
          valueMinor: parsed.valueMinor,
        },
        today,
      });
      if (!commandResult.ok) {
        return commandResult;
      }
      if (commandResult.value.changes === 0) {
        return {
          ok: false,
          error: "No se encontró la tasación — puede que ya se haya eliminado.",
        };
      }
      return { ok: true };
    },
    onError: ({ id, extra, error }) =>
      errorRedirectUrl(editUrl(id), {
        formId: `anchor-${extra.anchorId}`,
        message: error,
      }),
    onSuccess: ({ id }) => successRedirectUrl(editUrl(id), "anchor_saved", id),
  })(formData, ..._testArgs);
}

export async function deleteValuationAnchorAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    extraIds: ["anchorId"],
    missingId: "Identificador de tasación no encontrado.",
    run: async (store, { id, extra, today }) => {
      const asset = await findAsset(store, id);
      if (!asset || !isHousingAsset(asset)) {
        return { ok: false, error: "Solo los inmuebles pueden tener tasaciones." };
      }
      const commandResult = await executeDeleteValuationAnchorCommand(store, {
        anchorId: extra.anchorId!,
        today,
      });
      if (!commandResult.ok) {
        return commandResult;
      }
      if (commandResult.value.changes === 0) {
        return {
          ok: false,
          error: "No se encontró la tasación — puede que ya se haya eliminado.",
        };
      }
      return { ok: true };
    },
    onError: ({ id, error }) => errorRedirectUrl(editUrl(id), { message: error }),
    onSuccess: ({ id }) => successRedirectUrl(editUrl(id), "anchor_deleted", id),
  })(formData, ..._testArgs);
}

export async function setValuationCadenceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de deuda no encontrado.",
    parse: ({ formData, id }) => {
      const parsed = parseValuationCadenceStrict(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(editUrl(id), {
            formId: "cadence",
            message: parsed.error,
          }),
        };
      }
      return { ok: true, value: parsed.cadence };
    },
    run: async (store, { id, today, parsed: cadence }) => {
      const liability = await findLiability(store, id);
      if (!liability) {
        return { ok: false, error: "No se encontró la deuda." };
      }
      // Persist + re-ripple ride the seam (ADR 0020 / 0031): the cadence change is
      // a parameter edit, so the seam recuts the whole modeled curve behind it.
      await store.command.setLiabilityValuationCadence(id, cadence, { today });
      return { ok: true };
    },
    onError: ({ id, error }) =>
      errorRedirectUrl(editUrl(id), { formId: "cadence", message: error }),
    onSuccess: ({ id }) => successRedirectUrl(editUrl(id), "valuation_cadence_saved", id),
  })(formData, ..._testArgs);
}

export async function setHousingValuationCadenceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    parse: ({ formData, id }) => {
      const parsed = parseValuationCadenceStrict(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(editUrl(id), {
            formId: "cadence",
            message: parsed.error,
          }),
        };
      }
      return { ok: true, value: parsed.cadence };
    },
    run: async (store, { id, today, parsed: cadence }) => {
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
      await executeSetHousingValuationCadenceCommand(store, {
        assetId: id,
        cadence,
        today,
      });
      return { ok: true };
    },
    onError: ({ id, error }) =>
      errorRedirectUrl(editUrl(id), { formId: "cadence", message: error }),
    onSuccess: ({ id }) => successRedirectUrl(editUrl(id), "valuation_cadence_saved", id),
  })(formData, ..._testArgs);
}

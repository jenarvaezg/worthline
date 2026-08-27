"use server";

import {
  isClock,
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import { formAction } from "@web/form-action";
import {
  appendParam,
  errorRedirectUrl,
  mapDomainViolation,
  parseAppreciationRateStrict,
  parseHousingAcquisitionCostStrict,
  parseMoneyMinorField,
  parseValuationAnchorStrict,
  parseValuationCadenceStrict,
  parseValueUpdatePass,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import type { AcquisitionAnchorEditPreview } from "@worthline/db";
import {
  executeAddValuationAnchorCommand,
  executeDeleteValuationAnchorCommand,
  executePreviewAcquisitionAnchorEditCommand,
  executeRecordHousingValuationCommand,
  executeSetAnnualAppreciationRateCommand,
  executeSetHousingAcquisitionCostCommand,
  executeSetHousingValuationCadenceCommand,
  executeUpdateValuationAnchorCommand,
} from "@worthline/db";
import {
  checkManualValuationViolation,
  isHousingAsset,
  isValueUpdateEligible,
  systemClock,
} from "@worthline/domain";
import {
  baseUrl,
  boardAnchorResult,
  findAsset,
  findLiability,
  holdingBoardAnchor,
} from "./action-helpers";

export async function updateAssetValuationAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<number, string>({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    missingIdUrl: baseUrl,
    parse: ({ formData }) => {
      const currentValue = parseMoneyMinorField(formData, "currentValue");
      if (currentValue === null) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
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
      return boardAnchorResult(await holdingBoardAnchor(store, id));
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), {
        formId: "edit",
        message: error,
        values: preserveFields(formData, ["currentValue"]),
      }),
    onSuccess: ({ value }) => successRedirectUrl("/patrimonio", "saved", value),
  })(formData, ..._testArgs);
}

/**
 * Hand-set `liabilities.current_balance_minor` — the ONLY balance a debt without
 * a modelled curve has (#1290).
 *
 * The form is rendered only for such a debt, and this guard is the server half of
 * that rule: a debt with a plan, a re-baseline or an anchor takes its figure from
 * the curve, so writing the stored field would "save" with no figure moving. A
 * stale tab opened before the curve existed can still post here, and it must be
 * told where the real door is instead of silently succeeding.
 *
 * The question is asked through the SAME seam the batch pass uses
 * (`readCurveGovernedLiabilityIds`, #1334), so the two write surfaces cannot come
 * to different answers about the same debt.
 */
export async function updateLiabilityBalanceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<number, string>({
    datedFact: false,
    missingId: "Identificador de deuda no encontrado.",
    missingIdUrl: baseUrl,
    parse: ({ formData }) => {
      const balance = parseMoneyMinorField(formData, "balance");
      if (balance === null) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: "edit",
            message: "El saldo de la deuda no es válido.",
            values: preserveFields(formData, ["balance"]),
          }),
        };
      }
      return { ok: true, value: balance };
    },
    run: async (store, { id, parsed: balance }) => {
      if ((await store.liabilities.readCurveGovernedLiabilityIds()).has(id)) {
        return {
          error: mapDomainViolation({ code: "debt_balance_governed_by_curve" }),
          ok: false,
        };
      }

      await store.liabilities.updateLiabilityBalance(id, balance);
      return boardAnchorResult(await holdingBoardAnchor(store, id));
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(baseUrl(formData), {
        formId: "edit",
        message: error,
        values: preserveFields(formData, ["balance"]),
      }),
    onSuccess: ({ value }) => successRedirectUrl("/patrimonio", "saved", value),
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
      // Debts submitted here are collected in the same pass for the curve guard
      // below (their eligibility needs a read, so it is decided once, after).
      const liabilityIds = new Set(liabilities.map((l) => l.id));
      const submittedLiabilityIds: string[] = [];
      for (const [key] of formData.entries()) {
        if (!key.startsWith("val_")) continue;
        const id = key.slice(4);
        const asset = assetsById.get(id);
        if (asset && !isValueUpdateEligible(asset)) {
          const violation = checkManualValuationViolation(asset) ?? {
            code: "value_update_investment_holding" as const,
          };
          return { ok: false, error: mapDomainViolation(violation) };
        }
        if (liabilityIds.has(id)) {
          submittedLiabilityIds.push(id);
        }
      }

      // The debts' half of the same rule (#1334): a debt with a plan, a re-baseline
      // or a declared balance takes its figure from the curve, so writing its stored
      // balance would "save" with no figure moving — the same door the ficha closed
      // in #1290. The page no longer renders those rows; this catches the tab that
      // was open before the curve existed, and refuses the WHOLE batch rather than
      // writing part of it. One pass over the curve tables, and only when the
      // submission names a debt at all.
      if (submittedLiabilityIds.length > 0) {
        const curveGoverned = await store.liabilities.readCurveGovernedLiabilityIds();
        if (submittedLiabilityIds.some((id) => curveGoverned.has(id))) {
          return {
            error: mapDomainViolation({ code: "debt_balance_governed_by_curve" }),
            ok: false,
          };
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
    parse: ({ formData }) => {
      const parsed = parseAppreciationRateStrict(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
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
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "rate", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "rate_saved"),
  })(formData, ..._testArgs);
}

/**
 * Hand-set (or clear) a property's acquisition cost (#1441) — what was DISBURSED
 * to acquire it, the twin of an investment's cost basis.
 *
 * `datedFact: false` is the whole point of the action: this writes no dated fact
 * and re-derives no history. The curve, housing equity and every frozen snapshot
 * come from the VALUE anchors, so saving a cost must leave the past byte-identical
 * — the exact opposite of `setAppreciationRateAction` right above, whose seam has
 * to recut the curve. A blank clears the figure back to «todavía no lo sé», which
 * is an honest state: no cost, no return line, no invented 0 %.
 */
export async function setHousingAcquisitionCostAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    parse: ({ formData }) => {
      const parsed = parseHousingAcquisitionCostStrict(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: "acquisitionCost",
            message: parsed.error,
            values: preserveFields(formData, ["acquisitionCost"]),
          }),
        };
      }
      return { ok: true, value: { costMinor: parsed.costMinor } };
    },
    run: async (store, { id, parsed }) => {
      const asset = await findAsset(store, id);
      if (!asset) {
        return { ok: false, error: "No se encontró el activo." };
      }
      if (!isHousingAsset(asset)) {
        return {
          ok: false,
          error: "Solo los inmuebles pueden tener un coste de adquisición.",
        };
      }
      await executeSetHousingAcquisitionCostCommand(store, {
        assetId: id,
        costMinor: parsed.costMinor,
      });
      return { ok: true, value: { cleared: parsed.costMinor === null } };
    },
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "acquisitionCost", message: error }),
    onSuccess: ({ value }) =>
      successRedirectUrl(
        baseUrl(formData),
        value?.cleared ? "acquisition_cost_cleared" : "acquisition_cost_saved",
      ),
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
          redirect: errorRedirectUrl(baseUrl(formData), {
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
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "anchor", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "anchor_added"),
  })(formData, ..._testArgs);
}

/**
 * What the acquisition editor shows between «Ver cambios» and «Guardar» (#1562).
 * `summary` carries the two curves and the size of the rewrite; the confirm
 * re-reads the form, never this state.
 */
export type AcquisitionEditPreviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "summary"; preview: AcquisitionAnchorEditPreview };

/**
 * Dry run of the acquisition edit (#1562), for the preview→confirm island.
 *
 * Moving the acquisition date or price is a reconstruction: it redraws the whole
 * interpolated stretch up to the next appraisal — 22 years of curve in the
 * measured case — and re-ripples every snapshot since. This action answers what
 * that would do WITHOUT writing, through the same command the confirm uses, so
 * the two cannot disagree (#1438). Validation is the write's own parser, so a
 * date or a price the confirm would refuse is refused here too.
 */
export async function previewAcquisitionEditAction(
  _prev: AcquisitionEditPreviewState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<AcquisitionEditPreviewState> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(baseUrl(formData));

  const id = String(formData.get("id") ?? "").trim();
  const anchorId = String(formData.get("anchorId") ?? "").trim();
  if (id === "" || anchorId === "") {
    return { message: "Identificador de adquisición no encontrado.", status: "error" };
  }

  const today = _clock.today();
  // Seed 0: the parser derives an id for a NEW anchor and this dry run patches an
  // existing one, so the id is discarded — no reason to read a clock for it.
  const parsed = parseValuationAnchorStrict(formData, id, 0, today);
  if (!parsed.ok) {
    return { message: parsed.error, status: "error" };
  }

  const result = await runActionWithStore(
    (store) =>
      executePreviewAcquisitionAnchorEditCommand(store, {
        anchorId,
        input: {
          valuationDate: parsed.command.valuationDate,
          valueMinor: parsed.command.valueMinor,
        },
        today,
      }),
    _store,
  );

  if (!result.ok) {
    return { message: result.error, status: "error" };
  }
  return { preview: result.value, status: "summary" };
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
          redirect: errorRedirectUrl(baseUrl(formData), {
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
      errorRedirectUrl(baseUrl(formData), {
        formId: `anchor-${extra.anchorId}`,
        message: error,
      }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "anchor_saved"),
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
    onError: ({ error }) => errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "anchor_deleted"),
  })(formData, ..._testArgs);
}

export async function setValuationCadenceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de deuda no encontrado.",
    parse: ({ formData }) => {
      const parsed = parseValuationCadenceStrict(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
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
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "cadence", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "valuation_cadence_saved"),
  })(formData, ..._testArgs);
}

export async function setHousingValuationCadenceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de activo no encontrado.",
    parse: ({ formData }) => {
      const parsed = parseValuationCadenceStrict(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
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
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "cadence", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "valuation_cadence_saved"),
  })(formData, ..._testArgs);
}

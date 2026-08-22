"use server";

import { actionScopeExists, INVALID_SCOPE_MESSAGE } from "@web/action-scope";
import { currentUrlOf } from "@web/ajustes/connected-source-helpers";
import { formAction } from "@web/form-action";
import {
  appendParam,
  errorRedirectUrl,
  parseMoneyMinor,
  preserveFields,
} from "@web/intake";
import type { WorthlineStore } from "@web/store";
import {
  assertContributionAllowanceInput,
  consumesContributionAllowance,
} from "@worthline/domain";

/**
 * Annual contribution allowance intake (#1427, #1567) — "cupo anual de aportación".
 *
 * The cap is a plain declared amount. Destinations are **not** a form field: they
 * are every `pension_plan` with a ledger, resolved here so the user never ticks
 * "afecta al cupo". The store still persists the snapshot (export); usage always
 * re-derives from the instrument.
 *
 * Nothing here knows what a legal contribution limit is — the limit depends on
 * the year's law, on employer contributions and on earned income, so a number in
 * this code would be tax advice with an expiry date.
 */

type ParsedAllowanceForm =
  | { ok: true; label: string; annualCapMinor: number }
  | { ok: false; error: string };

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function preserveAllowanceFields(formData: FormData): Record<string, string> {
  return preserveFields(formData, ["label", "annualCap"]);
}

async function pensionPlanHoldingIds(store: WorthlineStore): Promise<string[]> {
  const assets = await store.assets.readAssets();
  return assets.filter(consumesContributionAllowance).map((asset) => asset.id);
}

/**
 * Read the form (name + cap). Destinations are resolved from the ledger in `run`,
 * then the DOMAIN says whether the whole input is valid.
 */
function parseAllowanceForm(formData: FormData): ParsedAllowanceForm {
  const label = field(formData, "label");
  const annualCapMinor = parseMoneyMinor(field(formData, "annualCap"));

  // The only rule this layer owns: what the user typed has to be a number at all.
  // "abc" is not a cap below zero, it is not a cap.
  if (annualCapMinor === null) {
    return { ok: false, error: "El tope anual debe ser un importe válido." };
  }

  return { ok: true, annualCapMinor, label };
}

type ValidAllowanceForm = Extract<ParsedAllowanceForm, { ok: true }>;

async function resolvedAllowanceInput(
  store: WorthlineStore,
  form: ValidAllowanceForm,
): Promise<{ ok: true; holdingIds: string[] } | { ok: false; error: string }> {
  const holdingIds = await pensionPlanHoldingIds(store);
  try {
    assertContributionAllowanceInput({
      annualCapMinor: form.annualCapMinor,
      holdingIds,
      label: form.label,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, holdingIds };
}

export async function createContributionAllowanceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ form: ValidAllowanceForm; scopeId: string }>({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    parse: ({ formData }) => {
      const parsed = parseAllowanceForm(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(currentUrlOf(formData), {
            anchor: "allowanceCreateForm",
            formId: "allowance",
            message: parsed.error,
            values: preserveAllowanceFields(formData),
          }),
        };
      }
      return { ok: true, value: { form: parsed, scopeId: field(formData, "scopeId") } };
    },
    run: async (store, { parsed }) => {
      if (!(await actionScopeExists(store, parsed.scopeId))) {
        return { ok: false, error: INVALID_SCOPE_MESSAGE };
      }
      const resolved = await resolvedAllowanceInput(store, parsed.form);
      if (!resolved.ok) return resolved;
      await store.contributionAllowances.createContributionAllowance({
        annualCapMinor: parsed.form.annualCapMinor,
        holdingIds: resolved.holdingIds,
        label: parsed.form.label,
        scopeId: parsed.scopeId,
      });
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(currentUrlOf(formData), {
        anchor: "allowanceCreateForm",
        formId: "allowance",
        message: error,
        values: preserveAllowanceFields(formData),
      }),
    onSuccess: ({ formData }) =>
      appendParam(currentUrlOf(formData), "ok", "allowance_saved"),
  })(formData, ..._testArgs);
}

export async function updateContributionAllowanceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ id: string; form: ValidAllowanceForm }>({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    parse: ({ formData }) => {
      const id = field(formData, "allowanceId");
      if (!id) {
        return {
          ok: false,
          redirect: errorRedirectUrl(currentUrlOf(formData), {
            formId: "allowance",
            message: "Identificador de cupo no encontrado.",
          }),
        };
      }
      const parsed = parseAllowanceForm(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(currentUrlOf(formData), {
            anchor: `allowanceEdit-${id}`,
            formId: `allowance-${id}`,
            message: parsed.error,
            values: preserveAllowanceFields(formData),
          }),
        };
      }
      return { ok: true, value: { form: parsed, id } };
    },
    run: async (store, { parsed }) => {
      const resolved = await resolvedAllowanceInput(store, parsed.form);
      if (!resolved.ok) return resolved;
      await store.contributionAllowances.updateContributionAllowance(parsed.id, {
        annualCapMinor: parsed.form.annualCapMinor,
        holdingIds: resolved.holdingIds,
        label: parsed.form.label,
      });
      return { ok: true };
    },
    onError: ({ formData, error }) => {
      const id = field(formData, "allowanceId");
      return errorRedirectUrl(currentUrlOf(formData), {
        anchor: `allowanceEdit-${id}`,
        formId: `allowance-${id}`,
        message: error,
        values: preserveAllowanceFields(formData),
      });
    },
    onSuccess: ({ formData }) =>
      appendParam(currentUrlOf(formData), "ok", "allowance_saved"),
  })(formData, ..._testArgs);
}

export async function deleteContributionAllowanceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    run: async (store) => {
      await store.contributionAllowances.deleteContributionAllowance(
        field(formData, "allowanceId"),
      );
      return { ok: true };
    },
    onError: ({ formData, error }) =>
      errorRedirectUrl(currentUrlOf(formData), { message: error }),
    onSuccess: ({ formData }) =>
      appendParam(currentUrlOf(formData), "ok", "allowance_deleted"),
  })(formData, ..._testArgs);
}

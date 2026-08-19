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
import { assertContributionAllowanceInput } from "@worthline/domain";

/**
 * Annual contribution allowance intake (#1427) — "cupo anual de aportación".
 *
 * The cap is a plain declared amount: this layer parses it and the store owns
 * the invariants (`assertContributionAllowanceInput`). Nothing here knows what a
 * legal contribution limit is, and nothing here ever should — the limit depends
 * on the year's law, on employer contributions and on earned income, so a number
 * in this code would be tax advice with an expiry date.
 */

type ParsedAllowanceForm =
  | { ok: true; label: string; annualCapMinor: number; holdingIds: string[] }
  | { ok: false; error: string };

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

/** Allowance form fields worth refilling after a validation error (holdings included). */
function preserveAllowanceFields(formData: FormData): Record<string, string> {
  return {
    ...preserveFields(formData, ["label", "annualCap"]),
    holdingIds: formData.getAll("holdingIds").map(String).join(","),
  };
}

/**
 * Read the form, then let the DOMAIN say whether it is valid. Restating the
 * invariants here would create a second owner of the same rules, and the two
 * would drift — the store enforces `assertContributionAllowanceInput` at the
 * door regardless, so this layer only turns its message into a redirect the user
 * can see beside the form that produced it.
 */
function parseAllowanceForm(formData: FormData): ParsedAllowanceForm {
  const label = field(formData, "label");
  const annualCapMinor = parseMoneyMinor(field(formData, "annualCap"));
  const holdingIds = formData
    .getAll("holdingIds")
    .map((value) => String(value).trim())
    .filter(Boolean);

  // The only rule this layer owns: what the user typed has to be a number at all.
  // "abc" is not a cap below zero, it is not a cap.
  if (annualCapMinor === null) {
    return { ok: false, error: "El tope anual debe ser un importe válido." };
  }

  try {
    assertContributionAllowanceInput({ annualCapMinor, holdingIds, label });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, annualCapMinor, holdingIds, label };
}

type ValidAllowanceForm = Extract<ParsedAllowanceForm, { ok: true }>;

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
      await store.contributionAllowances.createContributionAllowance({
        annualCapMinor: parsed.form.annualCapMinor,
        holdingIds: parsed.form.holdingIds,
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
      await store.contributionAllowances.updateContributionAllowance(parsed.id, {
        annualCapMinor: parsed.form.annualCapMinor,
        // Always sent: the form paints every eligible holding as a checkbox, so an
        // absent name means "unchecked", never "leave the set as it was". Reading it
        // as the latter would make a destination impossible to remove.
        holdingIds: parsed.form.holdingIds,
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

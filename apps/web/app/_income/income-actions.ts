"use server";

/**
 * The declaration door of an income (#1673, S2 of #1522; ADR 0108).
 *
 * ONE create action for both doors: the Rentas surface declares an income with no
 * asset (`createStandaloneIncomeAction`), and a holding's Cobros section binds its
 * own id into `createIncomeAction`. Same parser, same refusal, same write — so the
 * provenance the door requires cannot be skipped by declaring from the other side.
 *
 * The terminals are split (#1311, interaction-patterns §4.1): success redirects,
 * and a refusal comes back as state when the submit asked for it (`inlineError`,
 * stamped by the island). A form posted with JavaScript off keeps the redirect,
 * carrying its typed fields so nothing has to be re-typed.
 *
 * An income touches no figure, snapshot or ripple (ADR 0054/0108) — the writes go
 * through `store.payouts` only, so these are plain writes (`datedFact: false`).
 */

import { formAction, formActionInlineError } from "@web/form-action";
import { errorRedirectUrl, preserveFields, successRedirectUrl } from "@web/intake";
import { COBRO_FORM_ID } from "@web/inversiones/cobro-form-ids";
import { currentUrlOf } from "@web/inversiones/return-url";
import {
  buildIncomeResult,
  INCOME_FORM_FIELDS,
  incomeDeclarationFieldsFromForm,
  incomeFieldsFromForm,
  parseIncomeDeclaration,
} from "./income-form";

const INCOME_NOT_FOUND = "Renta no encontrada.";

/** Whether the workspace still holds this income — a stale form may name a gone one. */
async function incomeExists(
  store: { payouts: { readPayoutSchedules: () => Promise<Array<{ id: string }>> } },
  incomeId: string,
): Promise<boolean> {
  return (await store.payouts.readPayoutSchedules()).some(
    (income) => income.id === incomeId,
  );
}

/**
 * Declare an income. `holdingId` is the asset that generates it — bound by the
 * ficha it was declared on — or null for an income with no asset.
 *
 * The confirmation and the error's section follow the door: the ficha's Cobros
 * entry keeps its own words («Cobro recurrente», the recurring form's own formId, so
 * a no-JS refusal reopens that form — #1731 review), the Rentas surface says
 * «Renta» (formId `income`).
 */
export async function createIncomeAction(
  holdingId: string | null,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);
  const formId = holdingId === null ? "income" : COBRO_FORM_ID.recurring;

  return formActionInlineError({
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) => ({ error }),
    onErrorUrl: ({ error }) =>
      errorRedirectUrl(returnUrl, {
        formId,
        message: error,
        values: preserveFields(formData, [...INCOME_FORM_FIELDS]),
      }),
    onSuccess: () =>
      successRedirectUrl(
        returnUrl,
        holdingId === null ? "income_saved" : "payout_schedule_saved",
      ),
    parse: ({ today }) => {
      const result = buildIncomeResult(incomeFieldsFromForm(formData), today);
      return result.ok
        ? { ok: true, value: result.income }
        : { ok: false, error: result.error };
    },
    requireId: false,
    run: async (store, { parsed }) => {
      await store.payouts.createPayoutSchedule({ ...parsed, holdingId });
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

/** The Rentas surface's door: an income that no asset generates. */
export async function createStandaloneIncomeAction(
  formData: FormData,
  ..._testArgs: unknown[]
) {
  return createIncomeAction(null, formData, ..._testArgs);
}

/**
 * Correct the declaration proper of an existing income — nature, basis, provenance
 * and its cut-off, condition — leaving the recurrence untouched. A chosen «Sin
 * declarar» withdraws that declaration back to NULL, while a field the form did not
 * carry is left as it is: absent is not «sin declarar», so a partial form can never
 * wipe a declared `passive`. The provenance is required here exactly as it is at the
 * door, so correcting an income declared before the door existed is also when it
 * gains one.
 */
export async function updateIncomeDeclarationAction(
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);

  return formActionInlineError({
    datedFact: false,
    extraIds: ["incomeId"],
    guardUrl: () => returnUrl,
    missingId: INCOME_NOT_FOUND,
    missingIdUrl: () => returnUrl,
    onError: ({ error }) => ({ error }),
    // Its own formId, so a no-JS refusal rides the page's band instead of being
    // mistaken for a refused NEW declaration and refilling the door with it.
    onErrorUrl: ({ error }) =>
      errorRedirectUrl(returnUrl, { formId: "incomeDeclaration", message: error }),
    onSuccess: () => successRedirectUrl(returnUrl, "income_updated"),
    parse: ({ today }) => {
      const result = parseIncomeDeclaration(
        incomeDeclarationFieldsFromForm(formData),
        today,
      );
      return result.ok
        ? { ok: true, value: result.declaration }
        : { ok: false, error: result.error };
    },
    requireId: false,
    run: async (store, { extra, parsed }) => {
      const incomeId = extra.incomeId!;
      if (!(await incomeExists(store, incomeId))) {
        return { ok: false, error: INCOME_NOT_FOUND };
      }
      await store.payouts.updatePayoutSchedule(incomeId, parsed);
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

/**
 * Delete a declared income from the Rentas list. An id the workspace no longer
 * holds is refused as «no encontrada», like a correction — never confirmed as a
 * deletion that did not happen.
 */
export async function deleteIncomeAction(formData: FormData, ..._testArgs: unknown[]) {
  const returnUrl = currentUrlOf(formData);

  return formAction({
    datedFact: false,
    extraIds: ["incomeId"],
    guardUrl: () => returnUrl,
    missingId: INCOME_NOT_FOUND,
    missingIdUrl: () => returnUrl,
    onError: ({ error }) => errorRedirectUrl(returnUrl, { message: error }),
    onSuccess: () => successRedirectUrl(returnUrl, "income_deleted"),
    requireId: false,
    run: async (store, { extra }) => {
      const incomeId = extra.incomeId!;
      if (!(await incomeExists(store, incomeId))) {
        return { ok: false, error: INCOME_NOT_FOUND };
      }
      await store.payouts.deletePayoutSchedule(incomeId);
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

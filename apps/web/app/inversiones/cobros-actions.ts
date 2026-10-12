"use server";

/**
 * Payout attribution — "Cobros" (PRD #652 S1, #656, ADR 0054).
 *
 * A payout is a dated attribution record that a holding paid its owner an amount —
 * a pure fact, NEVER a figure: it touches no snapshot, no ripple, no net-worth
 * path, only the `store.payouts` methods. These four actions mirror the exposure
 * surface: `guardDemoWrite` first (through the combinator), an optional `_store`
 * seam for tests, and a redirect-with-message. Validation errors render beside the
 * Cobros form that posted them (its own formId, `cobro-form-ids.ts`), not on the
 * holding-edit form at the top of the page. Its own module since #1606.
 *
 * Declaring a recurring income is NOT here any more (#1673): the ficha binds its
 * holding into `createIncomeAction`, the one declaration door it shares with the
 * Rentas surface, so the provenance that door requires cannot be skipped from this
 * side. What stays is what only the ficha does to an income — end it, exclude a
 * month, declare its costs and lease terms, delete it.
 */

import { parseScheduleExpenses } from "@web/_income/income-recurrence";
import { parseLeaseTerms } from "@web/_income/lease-terms-form";
import { formAction } from "@web/form-action";
import { errorRedirectUrl, preserveFields, successRedirectUrl } from "@web/intake";
import { COBRO_FORM_ID } from "@web/inversiones/cobro-form-ids";
import { currentUrlOf } from "@web/inversiones/return-url";
import {
  buildPayoutResult,
  type PayoutFields,
  toggleExclusion,
} from "@web/patrimonio/[id]/editar/_surfaces/cobros-form";

/** The one-off form's fields — what it reads, and what a refusal carries back. */
const PAYOUT_FIELDS = ["amount", "dateISO", "note"] as const;

/** Lift the one-off payout inputs off the FormData into the pure field map. */
function parsePayoutFieldsFromForm(formData: FormData): PayoutFields {
  const str = (name: string) => String(formData.get(name) ?? "");
  return { dateISO: str("dateISO"), amount: str("amount"), note: str("note") };
}

export async function createPayoutAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);
  // A refusal goes back to the one-off form itself, with what was typed (#1731
  // review): the ficha reopens it in the «Añadir cobro» panel instead of a tab.
  const refused = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: COBRO_FORM_ID.oneOff,
      message,
      values: preserveFields(formData, [...PAYOUT_FIELDS]),
    });

  return formAction({
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) => refused(error),
    onSuccess: () => successRedirectUrl(returnUrl, "payout_saved"),
    parse: () => {
      const result = buildPayoutResult(parsePayoutFieldsFromForm(formData));
      if (!result.ok) {
        return { ok: false, redirect: refused(result.error) };
      }
      return { ok: true, value: result.payout };
    },
    requireId: false,
    run: async (store, { parsed }) => {
      await store.payouts.createPayout({ holdingId: routeAssetId, ...parsed });
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

export async function deletePayoutAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);

  return formAction({
    datedFact: false,
    extraIds: ["payoutId"],
    guardUrl: () => returnUrl,
    missingId: "Cobro no encontrado.",
    missingIdUrl: () => returnUrl,
    onError: ({ error }) => errorRedirectUrl(returnUrl, { message: error }),
    onSuccess: () => successRedirectUrl(returnUrl, "payout_deleted"),
    requireId: false,
    run: async (store, { extra }) => {
      await store.payouts.deletePayout(extra.payoutId!);
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

/**
 * Update a schedule via the ficha affordances (never a full re-entry): "terminar
 * hoy" posts an `endISO` (or `clearEnd=1` to reactivate a dead tail), "excluir mes"
 * posts an `excludeDate` that is toggled against the schedule's current exclusion
 * list (read back so the toggle is honest, not a blind append), the expenses row
 * posts `expenses` — a declaration that feeds the rent-derived FIRE return (#1448),
 * with an empty field meaning "withdraw the declaration", not "zero" — and the lease
 * row posts `saveLease=1` with the three declarations that decide what happens past
 * the mandatory term (#1521).
 */
export async function updatePayoutScheduleAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);

  return formAction({
    datedFact: false,
    extraIds: ["scheduleId"],
    guardUrl: () => returnUrl,
    missingId: "Cobro recurrente no encontrado.",
    missingIdUrl: () => returnUrl,
    // The record's own id: an invalid expenses declaration belongs beside the
    // Cobros record that posted it, not as a bare banner at the top of the ficha.
    onError: ({ error }) =>
      errorRedirectUrl(returnUrl, { formId: COBRO_FORM_ID.record, message: error }),
    onSuccess: () => successRedirectUrl(returnUrl, "payout_schedule_updated"),
    requireId: false,
    run: async (store, { extra }) => {
      const scheduleId = extra.scheduleId!;
      const excludeDate = String(formData.get("excludeDate") ?? "").trim();
      const endISO = String(formData.get("endISO") ?? "").trim();

      // `saveLease=1` marks the intent, exactly like `saveExpenses` below: an empty
      // select then reads as «retiro la declaración» instead of being
      // indistinguishable from a form that never carried the field (#1521).
      if (formData.get("saveLease") === "1") {
        const parsed = parseLeaseTerms({
          leaseRegime: String(formData.get("leaseRegime") ?? ""),
          rentRevision: String(formData.get("rentRevision") ?? ""),
          rentRevisionReference: String(formData.get("rentRevisionReference") ?? ""),
          postMandatoryTermPolicy: String(formData.get("postMandatoryTermPolicy") ?? ""),
        });
        if (!parsed.ok) {
          return { ok: false, error: parsed.error };
        }
        // Ficha-scoped, like every other branch here: the write only lands on a
        // schedule that belongs to the holding whose page posted it.
        const owned = (
          await store.payouts.readPayoutSchedulesForHolding(routeAssetId)
        ).some((candidate) => candidate.id === scheduleId);
        if (!owned) {
          return { ok: false, error: "Cobro recurrente no encontrado." };
        }
        await store.payouts.updatePayoutSchedule(scheduleId, parsed.terms);
        return { ok: true };
      }

      // `saveExpenses=1` marks the intent, so an empty field reads as "withdraw the
      // declaration" instead of being indistinguishable from a form that never
      // carried the input at all.
      if (formData.get("saveExpenses") === "1") {
        const parsed = parseScheduleExpenses(String(formData.get("expenses") ?? ""));
        if (!parsed.ok) {
          return { ok: false, error: parsed.error };
        }
        // Ficha-scoped, like the exclusion branch below: the write only lands on a
        // schedule that belongs to the holding whose page posted it.
        const owned = (
          await store.payouts.readPayoutSchedulesForHolding(routeAssetId)
        ).some((candidate) => candidate.id === scheduleId);
        if (!owned) {
          return { ok: false, error: "Cobro recurrente no encontrado." };
        }
        await store.payouts.updatePayoutSchedule(scheduleId, {
          expensesMinor: parsed.expensesMinor,
        });
        return { ok: true };
      }

      if (excludeDate) {
        const schedule = (
          await store.payouts.readPayoutSchedulesForHolding(routeAssetId)
        ).find((candidate) => candidate.id === scheduleId);
        if (schedule) {
          await store.payouts.updatePayoutSchedule(scheduleId, {
            exclusions: toggleExclusion(schedule.exclusions, excludeDate),
          });
        }
        return { ok: true };
      }
      if (formData.get("clearEnd") === "1") {
        await store.payouts.updatePayoutSchedule(scheduleId, { endISO: null });
        return { ok: true };
      }
      if (endISO) {
        await store.payouts.updatePayoutSchedule(scheduleId, { endISO });
      }
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

export async function deletePayoutScheduleAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);

  return formAction({
    datedFact: false,
    extraIds: ["scheduleId"],
    guardUrl: () => returnUrl,
    missingId: "Cobro recurrente no encontrado.",
    missingIdUrl: () => returnUrl,
    onError: ({ error }) => errorRedirectUrl(returnUrl, { message: error }),
    onSuccess: () => successRedirectUrl(returnUrl, "payout_schedule_deleted"),
    requireId: false,
    run: async (store, { extra }) => {
      await store.payouts.deletePayoutSchedule(extra.scheduleId!);
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

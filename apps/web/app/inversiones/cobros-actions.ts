"use server";

/**
 * Payout attribution — "Cobros" (PRD #652 S1, #656, ADR 0054).
 *
 * A payout is a dated attribution record that a holding paid its owner an amount —
 * a pure fact, NEVER a figure: it touches no snapshot, no ripple, no net-worth
 * path, only the `store.payouts` methods. These five actions mirror the exposure
 * surface: `guardDemoWrite` first (through the combinator), an optional `_store`
 * seam for tests, and a redirect-with-message. Validation errors render at the
 * "payout" section (its own formId), not on the holding-edit form at the top of
 * the page. Its own module since #1606.
 */

import { formAction } from "@web/form-action";
import { errorRedirectUrl, successRedirectUrl } from "@web/intake";
import { currentUrlOf } from "@web/inversiones/return-url";
import {
  buildPayoutResult,
  buildPayoutScheduleResult,
  type PayoutFields,
  type PayoutScheduleFields,
  parseScheduleExpenses,
  toggleExclusion,
} from "@web/patrimonio/[id]/editar/_surfaces/cobros-form";

/** Lift the one-off payout inputs off the FormData into the pure field map. */
function parsePayoutFieldsFromForm(formData: FormData): PayoutFields {
  const str = (name: string) => String(formData.get(name) ?? "");
  return { dateISO: str("dateISO"), amount: str("amount"), note: str("note") };
}

/** Lift the schedule inputs off the FormData into the pure field map. */
function parsePayoutScheduleFieldsFromForm(formData: FormData): PayoutScheduleFields {
  const str = (name: string) => String(formData.get(name) ?? "");
  return {
    label: str("label"),
    amount: str("amount"),
    cadence: str("cadence"),
    startISO: str("startISO"),
    endISO: str("endISO"),
    expenses: str("expenses"),
  };
}

export async function createPayoutAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);

  return formAction({
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) =>
      errorRedirectUrl(returnUrl, { formId: "payout", message: error }),
    onSuccess: () => successRedirectUrl(returnUrl, "payout_saved"),
    parse: () => {
      const result = buildPayoutResult(parsePayoutFieldsFromForm(formData));
      if (!result.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(returnUrl, {
            formId: "payout",
            message: result.error,
          }),
        };
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

export async function createPayoutScheduleAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);

  return formAction({
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) =>
      errorRedirectUrl(returnUrl, { formId: "payout", message: error }),
    onSuccess: () => successRedirectUrl(returnUrl, "payout_schedule_saved"),
    parse: () => {
      const result = buildPayoutScheduleResult(
        parsePayoutScheduleFieldsFromForm(formData),
      );
      if (!result.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(returnUrl, {
            formId: "payout",
            message: result.error,
          }),
        };
      }
      return { ok: true, value: result.schedule };
    },
    requireId: false,
    run: async (store, { parsed }) => {
      await store.payouts.createPayoutSchedule({ holdingId: routeAssetId, ...parsed });
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

/**
 * Update a schedule via the ficha affordances (never a full re-entry): "terminar
 * hoy" posts an `endISO` (or `clearEnd=1` to reactivate a dead tail), "excluir mes"
 * posts an `excludeDate` that is toggled against the schedule's current exclusion
 * list (read back so the toggle is honest, not a blind append), and the expenses row
 * posts `expenses` — a declaration that feeds the rent-derived FIRE return (#1448),
 * with an empty field meaning "withdraw the declaration", not "zero".
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
    // formId "payout": an invalid expenses declaration belongs beside the Cobros
    // section that posted it, not as a bare banner at the top of the ficha.
    onError: ({ error }) =>
      errorRedirectUrl(returnUrl, { formId: "payout", message: error }),
    onSuccess: () => successRedirectUrl(returnUrl, "payout_schedule_updated"),
    requireId: false,
    run: async (store, { extra }) => {
      const scheduleId = extra.scheduleId!;
      const excludeDate = String(formData.get("excludeDate") ?? "").trim();
      const endISO = String(formData.get("endISO") ?? "").trim();

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

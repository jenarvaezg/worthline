/**
 * The Cobros panel — the one advanced surface every ASSET carries, whatever its
 * family (PRD #652 S1, #656, ADR 0054).
 *
 * A payout is a pure attribution record: this holding paid its owner. It is never
 * a figure, so it belongs to no valuation family — a rented flat, a dividend fund
 * and a term deposit all take the same panel. The family decides only WHERE it
 * sits in its own order, which is why this loader returns the pieces instead of
 * rendering itself into the page: the whole section for a ficha that keeps the
 * accordion, or its record and its entry forms for a tabbed one (#1826), each
 * returning to whichever URL the family says its result shows on.
 *
 * It also hands back the payouts themselves, dated as the return engine reads
 * them, so a family that measures a return folds the rows this panel already read
 * instead of reading them twice (#657).
 *
 * A liability pays nobody: the page asks for this only for an asset, and the
 * reads below never happen on a debt ficha.
 */

import { createIncomeAction } from "@web/_income/income-actions";
import {
  createPayoutAction,
  deletePayoutAction,
  deletePayoutScheduleAction,
  updatePayoutScheduleAction,
} from "@web/inversiones/cobros-actions";
import type {
  FichaContext,
  PayoutsPanel,
} from "@web/patrimonio/[id]/editar/_families/family-contract";
import {
  CobrosEntry,
  type CobrosProps,
  CobrosRecord,
  CobrosSection,
} from "@web/patrimonio/[id]/editar/_surfaces/cobros-section";
import { acknowledgeWarningAction } from "@web/patrimonio/actions";
import type { ManualAsset, WarningOverride } from "@worthline/domain";
import { collectHoldingPayouts, isHousingAsset } from "@worthline/domain";
import { doubleCountNotice } from "./double-count-notice";

export async function loadPayoutsPanel(
  ficha: FichaContext,
  input: {
    /**
     * The holding this panel sits on. Taken whole rather than as a currency, so the
     * one branch this panel needs — whether its income can be a LEASE (#1521) — is
     * derived HERE and not as another instrument boolean on the page (ADR 0095).
     */
    asset: ManualAsset;
    /** The acknowledgements the page already read — «Es intencional» silences the cross. */
    overrides: readonly WarningOverride[];
    /** The scope whose declared spending frames the renta-pasiva coverage. */
    scopeId: string | undefined;
  },
): Promise<PayoutsPanel> {
  const { currentUrl, formError, id, isDemo, privacyMode, store, today } = ficha;
  const { asset, overrides, scopeId } = input;

  const [payouts, schedules, fireConfig] = await Promise.all([
    store.payouts.readPayoutsForHolding(id),
    store.payouts.readPayoutSchedulesForHolding(id),
    // Coverage is shown only when the scope HAS a FIRE monthly-spending figure;
    // otherwise it is omitted rather than invented.
    scopeId ? store.readFireConfig(today) : Promise.resolve(null),
  ]);

  // The double-count cross (#1675), by the same rule the health engine runs, over
  // the incomes read above.
  const doubleCount = doubleCountNotice({
    asset,
    incomes: schedules,
    overrides,
    todayISO: today,
  });

  async function boundCreatePayoutAction(formData: FormData) {
    "use server";
    await createPayoutAction(id, formData);
  }

  async function boundDeletePayoutAction(formData: FormData) {
    "use server";
    await deletePayoutAction(id, formData);
  }

  // The income declaration door with this holding bound (#1673): the same action as
  // the Rentas surface. It RETURNS a refusal (#1311 split terminal), so the binding
  // hands it back instead of swallowing it.
  async function boundCreateIncomeAction(formData: FormData) {
    "use server";
    return createIncomeAction(id, formData);
  }

  async function boundUpdatePayoutScheduleAction(formData: FormData) {
    "use server";
    await updatePayoutScheduleAction(id, formData);
  }

  async function boundDeletePayoutScheduleAction(formData: FormData) {
    "use server";
    await deletePayoutScheduleAction(id, formData);
  }

  const props = (returnUrl: string): CobrosProps => ({
    acknowledgeWarningAction,
    createIncomeAction: boundCreateIncomeAction,
    createPayoutAction: boundCreatePayoutAction,
    currency: asset.currency,
    currentUrl: returnUrl,
    deletePayoutAction: boundDeletePayoutAction,
    deletePayoutScheduleAction: boundDeletePayoutScheduleAction,
    doubleCount,
    error: formError?.formId === "payout" ? formError.message : null,
    errorValues: formError?.formId === "payout" ? formError.values : {},
    holdingId: id,
    monthlySpendingMinor: scopeId
      ? (fireConfig?.[scopeId]?.monthlySpendingMinor ?? null)
      : null,
    payouts,
    privacyMode,
    readOnly: isDemo,
    schedules,
    showLeaseTerms: isHousingAsset(asset),
    today,
    updatePayoutScheduleAction: boundUpdatePayoutScheduleAction,
  });

  return {
    count: payouts.length + schedules.length,
    // The same rows, the same rule the board's returns fold (#657): one-offs plus
    // each schedule's occurrences, up to today.
    datedPayouts: (collectHoldingPayouts(payouts, schedules, today).get(id) ?? []).map(
      (row) => ({ amountMinor: row.amountMinor, date: row.dateISO }),
    ),
    entry: (returnUrl) => <CobrosEntry {...props(returnUrl)} />,
    record: (returnUrl) => <CobrosRecord {...props(returnUrl)} />,
    section: <CobrosSection {...props(currentUrl)} />,
  };
}

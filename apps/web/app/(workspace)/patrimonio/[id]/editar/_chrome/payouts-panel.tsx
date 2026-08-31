/**
 * The Cobros panel — the one advanced surface every ASSET carries, whatever its
 * family (PRD #652 S1, #656, ADR 0054).
 *
 * A payout is a pure attribution record: this holding paid its owner. It is never
 * a figure, so it belongs to no valuation family — a rented flat, a dividend fund
 * and a term deposit all take the same panel. The family decides only WHERE it
 * sits in its own order, which is why this loader returns a node instead of
 * rendering itself into the page.
 *
 * A liability pays nobody: the page asks for this only for an asset, and the
 * reads below never happen on a debt ficha.
 */

import {
  createPayoutAction,
  createPayoutScheduleAction,
  deletePayoutAction,
  deletePayoutScheduleAction,
  updatePayoutScheduleAction,
} from "@web/inversiones/cobros-actions";
import type { FichaContext } from "@web/patrimonio/[id]/editar/_families/family-contract";
import { CobrosSection } from "@web/patrimonio/[id]/editar/_surfaces/cobros-section";
import type { ManualAsset } from "@worthline/domain";
import { isHousingAsset } from "@worthline/domain";
import type { ReactNode } from "react";

export async function loadPayoutsPanel(
  ficha: FichaContext,
  input: {
    /**
     * The holding this panel sits on. Taken whole rather than as a currency, so the
     * one branch this panel needs — whether its income can be a LEASE (#1521) — is
     * derived HERE and not as another instrument boolean on the page (ADR 0095).
     */
    asset: ManualAsset;
    /** The scope whose declared spending frames the renta-pasiva coverage. */
    scopeId: string | undefined;
  },
): Promise<ReactNode> {
  const { currentUrl, formError, id, privacyMode, store, today } = ficha;
  const { asset, scopeId } = input;

  const [payouts, schedules, fireConfig] = await Promise.all([
    store.payouts.readPayoutsForHolding(id),
    store.payouts.readPayoutSchedulesForHolding(id),
    // Coverage is shown only when the scope HAS a FIRE monthly-spending figure;
    // otherwise it is omitted rather than invented.
    scopeId ? store.readFireConfig(today) : Promise.resolve(null),
  ]);

  async function boundCreatePayoutAction(formData: FormData) {
    "use server";
    await createPayoutAction(id, formData);
  }

  async function boundDeletePayoutAction(formData: FormData) {
    "use server";
    await deletePayoutAction(id, formData);
  }

  async function boundCreatePayoutScheduleAction(formData: FormData) {
    "use server";
    await createPayoutScheduleAction(id, formData);
  }

  async function boundUpdatePayoutScheduleAction(formData: FormData) {
    "use server";
    await updatePayoutScheduleAction(id, formData);
  }

  async function boundDeletePayoutScheduleAction(formData: FormData) {
    "use server";
    await deletePayoutScheduleAction(id, formData);
  }

  return (
    <CobrosSection
      createPayoutAction={boundCreatePayoutAction}
      createPayoutScheduleAction={boundCreatePayoutScheduleAction}
      currency={asset.currency}
      currentUrl={currentUrl}
      deletePayoutAction={boundDeletePayoutAction}
      deletePayoutScheduleAction={boundDeletePayoutScheduleAction}
      error={formError?.formId === "payout" ? formError.message : null}
      monthlySpendingMinor={
        scopeId ? (fireConfig?.[scopeId]?.monthlySpendingMinor ?? null) : null
      }
      payouts={payouts}
      privacyMode={privacyMode}
      schedules={schedules}
      showLeaseTerms={isHousingAsset(asset)}
      today={today}
      updatePayoutScheduleAction={boundUpdatePayoutScheduleAction}
    />
  );
}

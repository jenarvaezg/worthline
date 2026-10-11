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

import { createIncomeAction } from "@web/_income/income-actions";
import {
  createPayoutAction,
  deletePayoutAction,
  deletePayoutScheduleAction,
  updatePayoutScheduleAction,
} from "@web/inversiones/cobros-actions";
import type { FichaContext } from "@web/patrimonio/[id]/editar/_families/family-contract";
import { CobrosSection } from "@web/patrimonio/[id]/editar/_surfaces/cobros-section";
import { acknowledgeWarningAction } from "@web/patrimonio/actions";
import type { ManualAsset, WarningOverride } from "@worthline/domain";
import {
  describeIncomeDoubleCount,
  INCOME_DOUBLE_COUNT_CODE,
  incomeDoubleCount,
  isHousingAsset,
} from "@worthline/domain";
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
    /** The acknowledgements the page already read — «Es intencional» silences the cross. */
    overrides: readonly WarningOverride[];
    /** The scope whose declared spending frames the renta-pasiva coverage. */
    scopeId: string | undefined;
  },
): Promise<ReactNode> {
  const { currentUrl, formError, id, isDemo, privacyMode, store, today } = ficha;
  const { asset, overrides, scopeId } = input;

  const [payouts, schedules, fireConfig] = await Promise.all([
    store.payouts.readPayoutsForHolding(id),
    store.payouts.readPayoutSchedulesForHolding(id),
    // Coverage is shown only when the scope HAS a FIRE monthly-spending figure;
    // otherwise it is omitted rather than invented.
    scopeId ? store.readFireConfig(today) : Promise.resolve(null),
  ]);

  // The double-count cross (#1675), by the same rule the health engine runs: the
  // ficha's holding and the incomes linked to it, read above. Acknowledged, it stays
  // in the inventory (ADR 0004) and stops asking here, exactly as a warning does.
  const cross = incomeDoubleCount(asset, schedules, today);
  const acknowledged = overrides.some(
    (override) => override.code === INCOME_DOUBLE_COUNT_CODE && override.entityId === id,
  );
  const doubleCount =
    cross === null || acknowledged ? null : describeIncomeDoubleCount(cross);

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

  return (
    <CobrosSection
      acknowledgeWarningAction={acknowledgeWarningAction}
      createPayoutAction={boundCreatePayoutAction}
      createIncomeAction={boundCreateIncomeAction}
      currency={asset.currency}
      currentUrl={currentUrl}
      deletePayoutAction={boundDeletePayoutAction}
      deletePayoutScheduleAction={boundDeletePayoutScheduleAction}
      doubleCount={doubleCount}
      error={formError?.formId === "payout" ? formError.message : null}
      errorValues={formError?.formId === "payout" ? formError.values : {}}
      holdingId={id}
      monthlySpendingMinor={
        scopeId ? (fireConfig?.[scopeId]?.monthlySpendingMinor ?? null) : null
      }
      payouts={payouts}
      privacyMode={privacyMode}
      readOnly={isDemo}
      schedules={schedules}
      showLeaseTerms={isHousingAsset(asset)}
      today={today}
      updatePayoutScheduleAction={boundUpdatePayoutScheduleAction}
    />
  );
}

/**
 * «Recalibrar con saldo real» (ADR 0056, PRD #670 S3, #678): the bank's real figure,
 * declared with its date, recalibrates the plan forward — the past is not touched.
 * The ficha's side panel (#1848).
 *
 * It carries the two magnitudes the person compares at the moment of repair: the
 * modelled balance of the curve as of today, and what accrued on it since the last
 * cuota (#1292) — because the bank shows the settlement amount and this form writes
 * PRINCIPAL, so pasting the former buries accrued interest inside the capital and
 * ripples it into every snapshot from that date.
 *
 * Offered only with a CURVE, plan row or re-baseline alike — the action's own guard
 * (#678): an imported current-state debt has a governing re-baseline and no plan row
 * and is still recalibrable.
 */

import type { FormErrorContext } from "@web/intake";
import { recalibrateDebtBalanceAction } from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";
import type { AccruedInterestAtDate } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import { DEBT_FORM_ID, FormRefusal } from "./debt-form-ids";

export function DebtRecalibrateForm({
  currentDebtAccrual,
  currentModelledBalanceMinor,
  currentUrl,
  formError,
  liabilityId,
  privacyMode,
  readOnly = false,
  today,
}: {
  /** Interest accrued since the last cuota (#1292); null with no running cycle. */
  currentDebtAccrual: AccruedInterestAtDate | null;
  /** The curve's balance as of today — the header's value. */
  currentModelledBalanceMinor: number;
  /** The «Plan» tab's URL: where the recalibration's notice shows. */
  currentUrl: string;
  formError: FormErrorContext | null;
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  liabilityId: string;
  privacyMode: boolean;
  /** Demo: the write-guard rejects it, so the submit is not offered (§10). */
  readOnly?: boolean;
  today: string;
}) {
  const values = formError?.formId === DEBT_FORM_ID.recalibrate ? formError.values : {};

  return (
    <>
      <p className="infoNote">
        Saldo modelado a día de hoy:{" "}
        <strong>
          {formatMoneyMinorPrivacy(
            { amountMinor: currentModelledBalanceMinor, currency: "EUR" },
            privacyMode,
          )}
        </strong>{" "}
        — capital pendiente. Si el saldo real de tu banco difiere, decláralo con su fecha
        para recalibrar el plan hacia delante — el pasado no se toca.
      </p>
      {currentDebtAccrual && currentDebtAccrual.accruedInterestMinor > 0 ? (
        <p className="infoNote">
          Tu banco suele enseñar el <strong>importe de liquidación</strong>: ese mismo
          capital más el interés corrido desde la última cuota (
          {currentDebtAccrual.cycleStartDate}), unos{" "}
          {formatMoneyMinorPrivacy(
            {
              amountMinor: currentDebtAccrual.accruedInterestMinor,
              currency: "EUR",
            },
            privacyMode,
          )}{" "}
          a día de hoy — es decir, cerca de{" "}
          {formatMoneyMinorPrivacy(
            {
              amountMinor: currentDebtAccrual.settlementEstimateMinor,
              currency: "EUR",
            },
            privacyMode,
          )}
          . Las dos cifras son correctas. Aquí se declara el{" "}
          <strong>capital pendiente</strong>: si pegas el importe de liquidación, esos
          intereses se quedan dentro del capital y ya no salen.
        </p>
      ) : null}
      <form
        action={recalibrateDebtBalanceAction}
        aria-label="Recalibrar saldo real"
        className="stackForm"
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={liabilityId} />
        <FormRefusal formError={formError} formId={DEBT_FORM_ID.recalibrate} />
        <label>
          <span>Saldo real (EUR)</span>
          <input
            aria-label="Saldo real (EUR)"
            defaultValue={values["rbOutstandingBalance"]}
            inputMode="decimal"
            min="0"
            name="rbOutstandingBalance"
            placeholder="118.000,00"
            required
          />
        </label>
        <label>
          <span>Fecha de recalibración</span>
          <input
            aria-label="Fecha de recalibración"
            defaultValue={values["rbBalanceDate"]}
            max={today}
            name="rbBalanceDate"
            required
            type="date"
          />
        </label>
        <div className="formActions">
          <PendingSubmit disabled={readOnly} pendingLabel="Recalibrando…">
            Recalibrar saldo
          </PendingSubmit>
        </div>
      </form>
    </>
  );
}

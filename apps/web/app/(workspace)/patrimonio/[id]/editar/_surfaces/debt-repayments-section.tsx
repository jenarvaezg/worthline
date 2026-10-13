/**
 * Early repayments of an amortizable debt's plan (amortización anticipada, PRD #146
 * / #150, #1848): «Registrar amortización anticipada» in the ficha's side panel —
 * the debt's habitual action once it has a plan — and the «Anticipadas» tab with the
 * table, each row with its inline edit and its two-step delete, as before.
 */

import { FreshMark, FreshTableRow } from "@web/_components/fresh-rows";
import type { FormErrorContext } from "@web/intake";
import {
  addEarlyRepaymentAction,
  deleteEarlyRepaymentAction,
  updateEarlyRepaymentAction,
} from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";
import type { EarlyRepaymentRecord } from "@worthline/db";
import { formatMoneyInput, formatMoneyMinorPrivacy } from "@worthline/domain";
import { DEBT_FORM_ID, FormRefusal, rowFormId } from "./debt-form-ids";
import { EARLY_REPAYMENT_MODE_LABELS } from "./debt-format";

/** The rows' list name, for the ficha to point at the one just added (#1829). */
export const REPAYMENTS_ROW_LIST = "anticipadas";

/** «Registrar amortización anticipada»: the panel form. */
export function EarlyRepaymentForm({
  currentUrl,
  formError,
  liabilityId,
  planId,
  readOnly = false,
  today,
}: {
  /** The «Anticipadas» tab's URL: where the new row shows. */
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  planId: string;
  /** Demo: the write-guard rejects it, so the submit is not offered (§10). */
  readOnly?: boolean;
  today: string;
}) {
  const values = formError?.formId === DEBT_FORM_ID.repayment ? formError.values : {};

  return (
    <form
      action={addEarlyRepaymentAction}
      aria-label="Registrar amortización anticipada"
      className="stackForm"
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="id" type="hidden" value={liabilityId} />
      <input name="planId" type="hidden" value={planId} />
      <FormRefusal formError={formError} formId={DEBT_FORM_ID.repayment} />
      <EarlyRepaymentFields max={today} values={values} />
      <PendingSubmit disabled={readOnly} pendingLabel="Registrando…">
        Registrar amortización
      </PendingSubmit>
    </form>
  );
}

/** The «Anticipadas» tab: every early repayment, newest first. */
export function EarlyRepaymentsTable({
  currentUrl,
  formError,
  liabilityId,
  planId,
  privacyMode,
  repayments,
  today,
}: {
  /** The «Anticipadas» tab's URL: where an edit or a delete returns. */
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  planId: string;
  privacyMode: boolean;
  repayments: readonly EarlyRepaymentRecord[];
  today: string;
}) {
  const sorted = [...repayments].sort((a, b) =>
    b.repaymentDate.localeCompare(a.repaymentDate),
  );

  return sorted.length > 0 ? (
    <div className="tableScroll debtRows debtSurface">
      <table aria-label="Amortizaciones anticipadas">
        <thead>
          <tr>
            <th>Fecha</th>
            <th className="numCol">Importe</th>
            <th>Tipo</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((repayment) => (
            <EarlyRepaymentRow
              currentUrl={currentUrl}
              formError={formError}
              key={repayment.id}
              liabilityId={liabilityId}
              max={today}
              planId={planId}
              privacyMode={privacyMode}
              repayment={repayment}
            />
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="emptyLine">Sin amortizaciones anticipadas registradas.</p>
  );
}

/** Shared date / amount / mode fields for the add and edit early-repayment forms. */
function EarlyRepaymentFields({
  max,
  values,
}: {
  max: string;
  values: Record<string, string>;
}) {
  return (
    <>
      <label>
        Fecha de la amortización
        <input
          aria-label="Fecha de la amortización"
          defaultValue={values["repaymentDate"]}
          max={max}
          name="repaymentDate"
          required
          type="date"
        />
      </label>
      <label>
        Importe en EUR
        <input
          aria-label="Importe en EUR"
          defaultValue={values["amount"]}
          inputMode="decimal"
          min="0"
          name="amount"
          placeholder="10000"
          required
        />
      </label>
      <label>
        Tipo de amortización
        <select
          aria-label="Tipo de amortización"
          defaultValue={values["mode"] ?? "reduce-payment"}
          name="mode"
        >
          <option value="reduce-payment">
            {EARLY_REPAYMENT_MODE_LABELS["reduce-payment"]}
          </option>
          <option value="reduce-term">
            {EARLY_REPAYMENT_MODE_LABELS["reduce-term"]}
          </option>
        </select>
      </label>
    </>
  );
}

/** One early-repayment row: data + inline edit (<details>) + two-step delete. */
function EarlyRepaymentRow({
  currentUrl,
  formError,
  liabilityId,
  max,
  planId,
  privacyMode,
  repayment,
}: {
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  max: string;
  planId: string;
  privacyMode: boolean;
  repayment: EarlyRepaymentRecord;
}) {
  const editing = formError?.formId === rowFormId(DEBT_FORM_ID.repayment, repayment.id);
  const editValues = editing
    ? formError.values
    : {
        amount: formatMoneyInput(repayment.amountMinor),
        mode: repayment.mode,
        repaymentDate: repayment.repaymentDate,
      };

  return (
    <FreshTableRow list={REPAYMENTS_ROW_LIST} rowKey={repayment.id}>
      <td>
        {repayment.repaymentDate}
        <FreshMark list={REPAYMENTS_ROW_LIST} rowKey={repayment.id} word="nueva" />
      </td>
      <td className="numCol">
        {formatMoneyMinorPrivacy(
          { amountMinor: repayment.amountMinor, currency: "EUR" },
          privacyMode,
        )}
      </td>
      <td>{EARLY_REPAYMENT_MODE_LABELS[repayment.mode]}</td>
      <td className="rowActions">
        <details suppressHydrationWarning className="anchorEdit" open={editing}>
          <summary>Editar</summary>
          <form
            action={updateEarlyRepaymentAction}
            aria-label="Editar amortización anticipada"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="planId" type="hidden" value={planId} />
            <input name="repaymentId" type="hidden" value={repayment.id} />
            <EarlyRepaymentFields max={max} values={editValues} />
            <div className="formActions">
              <button type="submit">Guardar amortización</button>
            </div>
          </form>
        </details>
        <form action={deleteEarlyRepaymentAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="planId" type="hidden" value={planId} />
          <input name="repaymentId" type="hidden" value={repayment.id} />
          <details suppressHydrationWarning className="confirmDelete">
            <summary>Eliminar</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      </td>
    </FreshTableRow>
  );
}

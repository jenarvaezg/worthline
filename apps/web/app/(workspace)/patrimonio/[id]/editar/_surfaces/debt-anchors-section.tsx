/**
 * Declared balances of a revolving or informal debt (PRD #109, #152, #1848):
 * «Registrar saldo» in the ficha's side panel — the debt's habitual action — and the
 * «Saldos» tab with the table, each row with its inline edit and its two-step
 * delete, as before.
 */

import { FreshMark, FreshTableRow } from "@web/_components/fresh-rows";
import type { FormErrorContext } from "@web/intake";
import {
  addBalanceAnchorAction,
  deleteBalanceAnchorAction,
  updateBalanceAnchorAction,
} from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";
import type { BalanceAnchorRecord } from "@worthline/db";
import { formatMoneyInput, formatMoneyMinorPrivacy } from "@worthline/domain";
import { DEBT_FORM_ID, FormRefusal, rowFormId } from "./debt-form-ids";

/** The rows' list name, for the ficha to point at the one just added (#1829). */
export const ANCHORS_ROW_LIST = "saldos";

/** «Registrar saldo»: the panel form. */
export function BalanceAnchorForm({
  currentUrl,
  formError,
  liabilityId,
  readOnly = false,
  today,
}: {
  /** The «Saldos» tab's URL: where the new row shows. */
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  /** Demo: the write-guard rejects it, so the submit is not offered (§10). */
  readOnly?: boolean;
  today: string;
}) {
  const values = formError?.formId === DEBT_FORM_ID.anchor ? formError.values : {};

  return (
    <form
      action={addBalanceAnchorAction}
      aria-label="Registrar saldo"
      className="stackForm"
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="id" type="hidden" value={liabilityId} />
      <FormRefusal formError={formError} formId={DEBT_FORM_ID.anchor} />
      <BalanceAnchorFields max={today} values={values} />
      <p className="infoNote">
        Declara el total adeudado en esa fecha (intereses incluidos).
      </p>
      <PendingSubmit disabled={readOnly} pendingLabel="Registrando…">
        Registrar saldo
      </PendingSubmit>
    </form>
  );
}

/** The «Saldos» tab: every declared balance, newest first. */
export function BalanceAnchorsTable({
  anchors,
  currentUrl,
  formError,
  liabilityId,
  privacyMode,
  today,
}: {
  anchors: readonly BalanceAnchorRecord[];
  /** The «Saldos» tab's URL: where an edit or a delete returns. */
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  privacyMode: boolean;
  today: string;
}) {
  const sorted = [...anchors].sort((a, b) => b.anchorDate.localeCompare(a.anchorDate));

  return sorted.length > 0 ? (
    <div className="tableScroll debtRows debtSurface">
      <table aria-label="Saldos declarados">
        <thead>
          <tr>
            <th>Fecha</th>
            <th className="numCol">Saldo</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((anchor) => (
            <BalanceAnchorRow
              anchor={anchor}
              currentUrl={currentUrl}
              formError={formError}
              key={anchor.id}
              liabilityId={liabilityId}
              max={today}
              privacyMode={privacyMode}
            />
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="emptyLine">Sin saldos declarados.</p>
  );
}

/** Shared date / balance fields for the add and edit balance-anchor forms. */
function BalanceAnchorFields({
  max,
  values,
}: {
  max: string;
  values: Record<string, string>;
}) {
  return (
    <>
      <label>
        Fecha del saldo
        <input
          aria-label="Fecha del saldo"
          defaultValue={values["anchorDate"]}
          max={max}
          name="anchorDate"
          required
          type="date"
        />
      </label>
      <label>
        Saldo restante (EUR)
        <input
          aria-label="Saldo restante en EUR"
          defaultValue={values["balance"]}
          inputMode="decimal"
          min="0"
          name="balance"
          placeholder="12.500"
          required
        />
      </label>
    </>
  );
}

/** One balance-anchor row: data + inline edit (<details>) + two-step delete. */
function BalanceAnchorRow({
  anchor,
  currentUrl,
  formError,
  liabilityId,
  max,
  privacyMode,
}: {
  anchor: BalanceAnchorRecord;
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  max: string;
  privacyMode: boolean;
}) {
  const editing = formError?.formId === rowFormId(DEBT_FORM_ID.anchor, anchor.id);
  const editValues = editing
    ? formError.values
    : {
        anchorDate: anchor.anchorDate,
        balance: formatMoneyInput(anchor.balanceMinor),
      };

  return (
    <FreshTableRow list={ANCHORS_ROW_LIST} rowKey={anchor.id}>
      <td>
        {anchor.anchorDate}
        <FreshMark list={ANCHORS_ROW_LIST} rowKey={anchor.id} word="nuevo" />
      </td>
      <td className="numCol">
        {formatMoneyMinorPrivacy(
          { amountMinor: anchor.balanceMinor, currency: "EUR" },
          privacyMode,
        )}
      </td>
      <td className="rowActions">
        <details suppressHydrationWarning className="anchorEdit" open={editing}>
          <summary>Editar</summary>
          <form
            action={updateBalanceAnchorAction}
            aria-label="Editar saldo"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="anchorId" type="hidden" value={anchor.id} />
            <BalanceAnchorFields max={max} values={editValues} />
            <div className="formActions">
              <button type="submit">Guardar saldo</button>
            </div>
          </form>
        </details>
        <form action={deleteBalanceAnchorAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="anchorId" type="hidden" value={anchor.id} />
          <details suppressHydrationWarning className="confirmDelete">
            <summary>Eliminar</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      </td>
    </FreshTableRow>
  );
}

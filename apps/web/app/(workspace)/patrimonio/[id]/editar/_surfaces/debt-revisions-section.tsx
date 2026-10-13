/**
 * Rate revisions of an amortizable debt's plan (PRD #109, #1848): «Registrar
 * revisión de tipo» in the ficha's side panel, and the «Revisiones» tab with the
 * table — each row with its inline edit and its two-step delete, as before.
 *
 * A revision moves the cuota from its date on; the header's «Cuota vigente» reads
 * it from the same curve as the balance, so the row added here is said up there too.
 */

import { formatDeclaredRatePercent } from "@web/_components/fine-percent";
import { FormRefusal, refusalAria, refusalFor } from "@web/_components/form-refusal";
import { FreshMark, FreshRow } from "@web/_components/fresh-rows";
import type { FormErrorContext } from "@web/intake";
import { formatDecimalAsPercentField } from "@web/intake-primitives";
import {
  addInterestRateRevisionAction,
  deleteInterestRateRevisionAction,
  updateInterestRateRevisionAction,
} from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";
import type { InterestRateRevisionRecord } from "@worthline/db";
import { DEBT_FORM_ID, rowFormId } from "./debt-form-ids";

const ERROR_ID = "revision-error";

/** The rows' list name, for the ficha to point at the one just added (#1829). */
export const REVISIONS_ROW_LIST = "revisiones";

/** «Registrar revisión de tipo»: the panel form. */
export function RevisionForm({
  currentUrl,
  formError,
  liabilityId,
  planId,
  readOnly = false,
  today,
}: {
  /** The «Revisiones» tab's URL: where the new row shows. */
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  planId: string;
  /** Demo: the write-guard rejects it, so the submit is not offered (§10). */
  readOnly?: boolean;
  today: string;
}) {
  const refusal = refusalFor(formError, DEBT_FORM_ID.revision);
  const values = refusal?.values ?? {};

  return (
    <form
      action={addInterestRateRevisionAction}
      aria-label="Registrar revisión de tipo"
      className="stackForm"
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="id" type="hidden" value={liabilityId} />
      <input name="planId" type="hidden" value={planId} />
      <FormRefusal id={ERROR_ID} refusal={refusal} />
      <RevisionFields
        errorId={refusal ? ERROR_ID : undefined}
        max={today}
        values={values}
      />
      <PendingSubmit disabled={readOnly} pendingLabel="Registrando…">
        Registrar revisión
      </PendingSubmit>
    </form>
  );
}

/** The «Revisiones» tab: every revision, newest first. */
export function RevisionsTable({
  currentUrl,
  formError,
  liabilityId,
  planId,
  revisions,
  today,
}: {
  /** The «Revisiones» tab's URL: where an edit or a delete returns. */
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  planId: string;
  revisions: readonly InterestRateRevisionRecord[];
  today: string;
}) {
  const sorted = [...revisions].sort((a, b) =>
    b.revisionDate.localeCompare(a.revisionDate),
  );

  return sorted.length > 0 ? (
    <div className="tableScroll debtRows debtSurface">
      <table aria-label="Revisiones de tipo">
        <thead>
          <tr>
            <th>Fecha</th>
            <th className="numCol">Nuevo tipo</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((revision) => (
            <RevisionRow
              currentUrl={currentUrl}
              formError={formError}
              key={revision.id}
              liabilityId={liabilityId}
              max={today}
              planId={planId}
              revision={revision}
            />
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="emptyLine">Sin revisiones de tipo registradas.</p>
  );
}

/** Shared date / rate fields for the add and edit revision forms. */
function RevisionFields({
  errorId,
  max,
  values,
}: {
  /** The panel form's refusal, printed above the fields, which they point at. */
  errorId?: string | undefined;
  max: string;
  values: Record<string, string>;
}) {
  return (
    <>
      <label>
        Fecha de la revisión
        <input
          {...refusalAria(errorId)}
          aria-label="Fecha de la revisión"
          defaultValue={values["revisionDate"]}
          max={max}
          name="revisionDate"
          required
          type="date"
        />
      </label>
      <label>
        Nuevo tipo de interés (%)
        <input
          {...refusalAria(errorId)}
          aria-label="Nuevo tipo de interés (%)"
          defaultValue={values["newAnnualInterestRate"]}
          inputMode="decimal"
          min="0"
          name="newAnnualInterestRate"
          placeholder="3"
          required
        />
      </label>
    </>
  );
}

/** One revision row: data + inline edit (<details>) + two-step delete. */
function RevisionRow({
  currentUrl,
  formError,
  liabilityId,
  max,
  planId,
  revision,
}: {
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  max: string;
  planId: string;
  revision: InterestRateRevisionRecord;
}) {
  const editing = formError?.formId === rowFormId(DEBT_FORM_ID.revision, revision.id);
  const editValues = editing
    ? formError.values
    : {
        newAnnualInterestRate: formatDecimalAsPercentField(
          Number(revision.newAnnualInterestRate),
        ),
        revisionDate: revision.revisionDate,
      };

  return (
    <FreshRow as="tr" list={REVISIONS_ROW_LIST} rowKey={revision.id}>
      <td>
        {revision.revisionDate}
        <FreshMark list={REVISIONS_ROW_LIST} rowKey={revision.id} word="nueva" />
      </td>
      <td className="numCol">
        {formatDeclaredRatePercent(Number(revision.newAnnualInterestRate))}
      </td>
      <td className="rowActions">
        <details suppressHydrationWarning className="anchorEdit" open={editing}>
          <summary>Editar</summary>
          <form
            action={updateInterestRateRevisionAction}
            aria-label="Editar revisión de tipo"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="planId" type="hidden" value={planId} />
            <input name="revisionId" type="hidden" value={revision.id} />
            <RevisionFields max={max} values={editValues} />
            <div className="formActions">
              <button type="submit">Guardar revisión</button>
            </div>
          </form>
        </details>
        <form action={deleteInterestRateRevisionAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="planId" type="hidden" value={planId} />
          <input name="revisionId" type="hidden" value={revision.id} />
          <details suppressHydrationWarning className="confirmDelete">
            <summary>Eliminar</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      </td>
    </FreshRow>
  );
}

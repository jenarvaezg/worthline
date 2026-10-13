/**
 * The disconnect CHOICE of a connected source (PRD #160 story 21, PRD #245 S6), in
 * its two placements: folded under its row in Conexiones, and alone in the side
 * panel of the holding's ficha (#1849).
 *
 * One zero-JS form (ADR 0009) with two submit buttons that post a `mode`:
 *  - "remove" — eliminate the live holding(s); frozen snapshots keep the history.
 *  - "freeze" — convert into a plain hand-maintained holding, keeping its value.
 *
 * The words are each source's (`DisconnectCopy`); the shape is one, so the two
 * sources read identically wherever the user disconnects.
 */

import type { FormErrorContext } from "@web/intake";
import { PendingSubmit } from "@web/pending-submit";
import { RETURN_AFTER_REMOVE_FIELD } from "./connected-source-form-ids";

/** What a source says about its own disconnect. */
export interface DisconnectCopy {
  /** Above the two options: what happens to the key, and that a choice follows. */
  intro: string;
  /** Under «Eliminar y conservar histórico». */
  remove: string;
  /** Under «Convertir en activo manual». */
  freeze: string;
}

type DisconnectAction = (formData: FormData) => void | Promise<void>;

const ERROR_ID = "disconnect-error";

/** The two options, each a button over its one-line consequence. */
function DisconnectOptions({
  copy,
  readOnly = false,
}: {
  copy: DisconnectCopy;
  readOnly?: boolean;
}) {
  return (
    <>
      <p className="dangerExplain">{copy.intro}</p>
      <div className="disconnectChoice">
        <div className="disconnectOption">
          <PendingSubmit disabled={readOnly} name="mode" value="remove">
            Eliminar y conservar histórico
          </PendingSubmit>
          <span className="muted">{copy.remove}</span>
        </div>
        <div className="disconnectOption">
          <PendingSubmit
            className="disconnectFreeze"
            disabled={readOnly}
            name="mode"
            value="freeze"
          >
            Convertir en activo manual
          </PendingSubmit>
          <span className="muted">{copy.freeze}</span>
        </div>
      </div>
    </>
  );
}

/** Folded under a summary: Conexiones' row. */
export function DisconnectFold({
  action,
  copy,
  currentUrl,
  sourceId,
  summary,
}: {
  action: DisconnectAction;
  copy: DisconnectCopy;
  currentUrl: string;
  sourceId: string;
  summary: string;
}) {
  return (
    <form action={action}>
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="sourceId" type="hidden" value={sourceId} />
      <details suppressHydrationWarning className="confirmDelete">
        <summary>{summary}</summary>
        <DisconnectOptions copy={copy} />
      </details>
    </form>
  );
}

/**
 * Alone in the ficha's side panel (#1849): the panel is already the step that
 * confirms, so nothing is folded. «Convertir en activo manual» comes back here, to
 * the same holding, now a hand-kept one; «Eliminar y conservar histórico» removes
 * the holding this ficha is about, so it lands on the board. A refusal comes back
 * with its own `formId`, reopens this panel and is printed here, once.
 */
export function DisconnectPanelForm({
  action,
  copy,
  currentUrl,
  formError,
  formId,
  readOnly,
  sourceId,
}: {
  action: DisconnectAction;
  copy: DisconnectCopy;
  /** The ficha: where a refusal and a freeze return. */
  currentUrl: string;
  formError: FormErrorContext | null;
  /** The `formId` its action tags a refusal with. */
  formId: string;
  /** Demo: the write-guard rejects it, so neither submit is offered (§10). */
  readOnly: boolean;
  sourceId: string;
}) {
  const refusal = formError?.formId === formId ? formError : null;

  return (
    <form
      action={action}
      aria-describedby={refusal ? ERROR_ID : undefined}
      className="confirmDelete"
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name={RETURN_AFTER_REMOVE_FIELD} type="hidden" value="/patrimonio" />
      <input name="sourceId" type="hidden" value={sourceId} />
      {refusal ? (
        <p className="errorBand" id={ERROR_ID} role="alert">
          {refusal.message}
        </p>
      ) : null}
      <DisconnectOptions copy={copy} readOnly={readOnly} />
    </form>
  );
}

"use client";

/**
 * The record form of an investment's operations (#152, ADR 0006/0014) — the one
 * door through which units change. Since #1826 it lives in the ficha's side panel,
 * apart from the ledger it writes into (`operations-ledger.tsx`); the two share the
 * optimistic list through `OperationsBookProvider`.
 *
 * Optimistic (#521, interaction-patterns §4): recording adds the typed row to the
 * shared book at once, then the terminal settles it. In demo (`readOnly`) the
 * optimism is skipped and the form posts plainly (§10).
 *
 * The record terminal is SPLIT (#1311): success redirects, a refusal comes BACK as
 * state and is rendered here, in place. A rejection used to ride a redirect too,
 * and a redirect terminal is discarded whole if any navigation lands while the
 * action is in flight — leaving an emptied form and no reason on screen. Returned
 * state has no navigation to lose. See `formActionInlineError` in
 * `app/form-action.ts` for the mechanism.
 */

import type { FormErrorContext } from "@web/intake";
import { operationKindLabel } from "@web/operation-kind-copy";
import type { CaptureCurrency } from "@worthline/domain";
import { BASE_CURRENCY, CAPTURE_CURRENCIES, isCaptureCurrency } from "@worthline/domain";
import { type FormEvent, useRef, useState, useTransition } from "react";
import { useFormSeed } from "./form-seed";
import { useOperationsBook } from "./operations-book";
import {
  type OperationRejection,
  planOperationSubmit,
  type RecordActionResult,
  rejectionOf,
  submitOperationRecord,
} from "./optimistic-operations";

/**
 * The record form's submit button (#1394). It goes disabled while the action is
 * in flight, so the second of two clicks never reaches the server — the visible
 * half of the double-submit guard, whose server half is the idempotency key in
 * `planOperationSubmit`. Its own component so the pending markup is assertable
 * without a DOM: `PendingSubmit` cannot serve here because the JS path
 * `preventDefault`s and calls the action by hand, leaving `useFormStatus` idle.
 */
export function RecordOperationSubmit({ pending }: { pending: boolean }) {
  return (
    <button aria-busy={pending} disabled={pending} type="submit">
      {pending ? "Registrando…" : "Registrar operación"}
    </button>
  );
}

export function OperationRecordForm({
  assetId,
  currentUrl,
  defaultCurrency,
  formError,
  heldUnits,
  readOnly = false,
  recordAction,
  today,
}: {
  /** The holding id the optimistic row is tagged with (the bound action owns it server-side). */
  assetId: string;
  /** Where the terminal returns: the ficha, on the tab where the new row shows. */
  currentUrl: string;
  /**
   * The currency the picker starts on (#1401): the one this holding's last apunte
   * was captured in, so a user buying the same dollar fund for the ninth time types
   * it once. Absent means EUR.
   */
  defaultCurrency?: CaptureCurrency | undefined;
  formError: FormErrorContext | null;
  /** The units held now, for the client's oversell check before anything is sent. */
  heldUnits: string;
  /** Demo: skip optimistic state — the write-guard rejects, so optimism would flicker (§10). */
  readOnly?: boolean;
  /**
   * Records the operation. Resolves to nothing on success (it redirects) and to
   * the refusal otherwise (#1311) — see {@link RecordActionResult}.
   */
  recordAction: (formData: FormData) => RecordActionResult | Promise<RecordActionResult>;
  today: string;
}) {
  const { addPending } = useOperationsBook();
  // «Añadir otra» (#1829): the date and currency of the operation just recorded,
  // when that is what re-opened this form. A refusal's own values still win.
  const { values: seeded } = useFormSeed();

  // The refusal the LAST submit handed back (#1311). It supersedes the one read
  // off the URL the moment it exists, because it is this submit's: the action no
  // longer redirects to deliver a rejection, so nothing navigates and the reason
  // cannot be discarded with a navigation that never happened. The URL one stays
  // as the terminal of a form posted with JavaScript off.
  const [returnedRejection, setReturnedRejection] = useState<OperationRejection | null>(
    null,
  );
  const urlRejection: OperationRejection | null =
    formError?.formId === "operation"
      ? { message: formError.message, values: formError.values }
      : null;
  const rejection = returnedRejection ?? urlRejection;
  const operationValues = rejection?.values ?? {};

  const [isRecording, startRecording] = useTransition();
  // The idempotency key of the record submit currently in flight (#1394), null
  // between submits. Held in a ref, not state: it must be readable and writable
  // from inside the submit handler without waiting for a render, which is the
  // whole point — the two clicks that duplicated an operation happened before
  // `isRecording` had a chance to flip.
  const inFlightSubmissionId = useRef<string | null>(null);
  // The currency the two money fields are labelled in (#1401). Client state because
  // the labels have to change AS the picker moves — the whole guard against typing
  // dollars under a «(EUR)» label — and it is a view toggle, so no page reload
  // (interaction-patterns §2). Without JS the select still posts its value and the
  // server converts identically; only the live relabelling is lost.
  // Narrowed, not trusted: `operationValues` can come back off a URL, so a hand-edited
  // `v_currency=JPY` would otherwise sit in the picker with no matching option (and the
  // server would refuse the submit for a reason the form never showed).
  const roundTripped = operationValues["currency"] ?? seeded["currency"];
  const [captureCurrency, setCaptureCurrency] = useState<CaptureCurrency>(
    roundTripped !== undefined && isCaptureCurrency(roundTripped)
      ? roundTripped
      : (defaultCurrency ?? BASE_CURRENCY),
  );
  const [clientOversell, setClientOversell] = useState<string | null>(null);
  const serverOversell = rejection?.values["oversellPending"] === "1";
  const oversellMessage = clientOversell ?? (serverOversell ? rejection.message : null);
  const oversellPending = oversellMessage !== null;
  const convertsToEur = captureCurrency !== BASE_CURRENCY;

  // Record: build the optimistic row from the form, apply it, then run the action —
  // all in the transition so `useOptimistic` tracks it and `isRecording` holds
  // until the terminal lands. With JS on, EVERY submit leaves from here (#1311):
  // a refusal has to come back as state, and React's own submit would send it
  // through the redirect terminal that can be discarded. In demo we let the form
  // fall back to its plain `action=` post (no faked optimism, §10).
  const onRecord = readOnly
    ? undefined
    : (event: FormEvent<HTMLFormElement>) => {
        const formData = new FormData(event.currentTarget);
        const plan = planOperationSubmit({
          assetId,
          formData,
          heldUnits,
          inFlightSubmissionId: inFlightSubmissionId.current,
          newId: () => crypto.randomUUID(),
          today,
        });
        event.preventDefault();
        if (plan.kind === "confirm-oversell") {
          setClientOversell(plan.message);
          return;
        }
        // Ask for the refusal as returned state rather than as a redirect
        // (#1311). Stamped HERE and not in the rendered HTML on purpose: a form
        // posted with JavaScript off cannot carry it, so it keeps the redirect
        // terminal that is the only one it can render.
        formData.set("inlineError", "1");
        // Clear the previous refusal as the retry leaves: keeping it on screen
        // while a new submit is in flight would show a stale reason next to a
        // form that has already moved on.
        setReturnedRejection(null);
        setClientOversell(null);
        if (plan.kind === "native") {
          // No buildable draft (blank units/price), so there is no optimistic row
          // to add and no idempotency key to carry — the server seeds the id off
          // the clock exactly as before. What this path must NOT do is fall
          // through to React's own submit: with JS on that is not a document
          // post, it is the same server action with the losable redirect
          // terminal, and this is the very submit #1311 loses. So it goes out
          // from here, asking for its refusal inline. With JS off the browser
          // really does post, `inlineError` is absent, and the server redirects.
          startRecording(async () => {
            setReturnedRejection(rejectionOf(await recordAction(formData)));
          });
          return;
        }
        submitOperationRecord({
          addPending,
          formData,
          keyRef: inFlightSubmissionId,
          onSettled: (result) => setReturnedRejection(rejectionOf(result)),
          plan,
          recordAction,
          startTransition: startRecording,
        });
      };

  return (
    <>
      {/* Announce the in-flight save for screen readers (§8); the settled outcome
          rides the page's status band after the redirect. */}
      <p aria-live="polite" className="srOnly">
        {isRecording ? "Guardando…" : ""}
      </p>

      {oversellPending ? (
        <p className="warningBand" role="alert" id="operation-error">
          {oversellMessage}
        </p>
      ) : rejection ? (
        <p className="errorBand" role="alert" id="operation-error">
          {rejection.message}
        </p>
      ) : null}

      <form
        // The SAME server action reference, not a wrapper: `action=` is the
        // no-JS path, and React only renders the progressively-enhanceable form
        // when it can see the server action itself. React discards whatever the
        // action resolves to on that path — which is correct here, since without
        // `inlineError` in the body it redirects and never returns a rejection —
        // but `action=`'s type cannot say "returns something I will ignore".
        action={recordAction as (formData: FormData) => void | Promise<void>}
        aria-label="Registrar operación"
        className="stackForm inversionesForm"
        onSubmit={onRecord}
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />

        <label>
          Tipo
          {/* Buys and sells only: a traspaso is one move with two halves and is
              written through its own door, never as half a pair typed here (#1393). */}
          <select defaultValue={operationValues["kind"] ?? "buy"} name="kind">
            <option value="buy">{operationKindLabel("buy")}</option>
            <option value="sell">{operationKindLabel("sell")}</option>
          </select>
        </label>

        <label>
          Fecha
          <input
            aria-label="Fecha de ejecución"
            defaultValue={operationValues["executedAt"] ?? seeded["executedAt"] ?? today}
            name="executedAt"
            type="date"
          />
        </label>

        <label>
          Unidades
          <input
            aria-label="Unidades"
            aria-required="true"
            defaultValue={operationValues["units"]}
            inputMode="decimal"
            name="units"
            placeholder="10"
          />
        </label>

        <label>
          Divisa del apunte
          <select
            name="currency"
            onChange={(event) => {
              if (isCaptureCurrency(event.target.value)) {
                setCaptureCurrency(event.target.value);
              }
            }}
            value={captureCurrency}
          >
            {CAPTURE_CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </label>

        <label>
          Precio por unidad ({captureCurrency})
          <input
            aria-label={`Precio por unidad en ${captureCurrency}`}
            aria-required="true"
            defaultValue={operationValues["pricePerUnit"]}
            inputMode="decimal"
            name="pricePerUnit"
            placeholder="100,00"
          />
        </label>

        <label>
          Comisiones ({captureCurrency}) <small>(opcional)</small>
          <input
            aria-label={`Comisiones en ${captureCurrency}`}
            defaultValue={operationValues["fees"] ?? "0"}
            inputMode="decimal"
            name="fees"
            placeholder="0"
          />
        </label>

        {/* Said BEFORE the submit, not after: the conversion is dated to the
            execution day, which is the fact that decides whether the cost basis is
            right (#1401). */}
        {convertsToEur ? (
          <p className="opCaptureHint">
            Lo guardaremos en euros con el tipo del BCE del día de la operación.
          </p>
        ) : null}

        {oversellPending ? (
          <label className="checkLine">
            <input
              defaultChecked={operationValues["oversellConfirmed"] === "1"}
              name="oversellConfirmed"
              type="checkbox"
              value="1"
            />{" "}
            Confirmo la venta
          </label>
        ) : null}

        <RecordOperationSubmit pending={isRecording} />
      </form>
    </>
  );
}

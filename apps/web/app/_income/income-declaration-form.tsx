"use client";

/**
 * The declaration door of an income (#1673, S2 of #1522) — ONE form, two places:
 * the Rentas surface, where an income needs no asset, and a holding's Cobros
 * section, where the asset is already linked (and the form also offers the costs
 * and, for a rented property, the lease terms the ficha always had).
 *
 * The submit is optimistic (interaction-patterns §4/§7) and its choreography is
 * the pure `submitIncomeMutation`: the same parser the server runs decides here,
 * before any round-trip, whether the declaration is refused — the reason shows at
 * once, beside the form, with everything typed still in place — or becomes a row.
 * The row goes to the list that owns it (`applyOptimistic`, the Rentas ledger) or,
 * on a ficha whose list is server-rendered, under the form until the redirect
 * brings the real one. The terminals are split (#1311): a refusal the server
 * returns comes back as state, never through a navigation that could be discarded
 * with the reason in it. In demo the form posts plainly and fakes nothing (§10).
 * Without JavaScript it is a plain form post with the redirect terminal, and a
 * refusal refills it from the URL.
 *
 * Why this is a client island (§11): the instant refusal IS the feature — a
 * provenance forgotten must not cost a round-trip and a re-typed form — and it
 * needs the parser in the browser. The parser is a pure module with no
 * dependency beyond the domain's money parsing; the rest of the ficha stays server.
 */

import type { Income } from "@worthline/domain";
import { type FormEvent, useOptimistic, useRef, useState, useTransition } from "react";
import { IncomeDeclarationInputs } from "./income-declaration-inputs";
import { IncomeDeclarationSummary } from "./income-declaration-summary";
import { PAYOUT_CADENCE_LABELS } from "./income-recurrence";
import { LeaseTermFields } from "./lease-term-fields";
import {
  applyIncomeMutations,
  type IncomeAction,
  type IncomeMutation,
  planIncomeSubmit,
  submitIncomeMutation,
} from "./optimistic-incomes";

export interface IncomeDeclarationFormProps {
  /**
   * Appended to the accessible names of the recurrence fields where another form on
   * the same page has fields with the same visible labels — the ficha's one-off
   * payout form also asks for an «Importe». Absent: the visible labels are the names.
   */
  accessibleSuffix?: string;
  /** The bound create action: redirects on success, hands a refusal back otherwise. */
  action: IncomeAction;
  /** The list's optimistic setter. Absent: the form shows its own pending row. */
  applyOptimistic?: (mutation: IncomeMutation) => void;
  currentUrl: string;
  /** The holding the income is linked to (a ficha), or null (the Rentas surface). */
  holdingId: string | null;
  /** A refusal a no-JS post brought back on the URL, with what it had typed. */
  initialError: string | null;
  initialValues: Readonly<Record<string, string>>;
  /** Demo: plain post, no optimism — the write guard refuses it anyway (§10). */
  readOnly: boolean;
  /** Only on a ficha whose income can be a lease (#1521). */
  showLeaseTerms: boolean;
  submitLabel: string;
  title: string;
  today: string;
}

export function IncomeDeclarationForm({
  accessibleSuffix,
  action,
  applyOptimistic,
  currentUrl,
  holdingId,
  initialError,
  initialValues,
  readOnly,
  showLeaseTerms,
  submitLabel,
  title,
  today,
}: IncomeDeclarationFormProps) {
  const [rejection, setRejection] = useState<string | null>(null);
  // The ficha's own pending rows — the same fold as the Rentas ledger, over nothing.
  const [pendingRows, applyPendingRow] = useOptimistic(
    [] as readonly Income[],
    (current: readonly Income[], mutation: IncomeMutation) =>
      applyIncomeMutations(current, [mutation]),
  );
  const [isPending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const error = rejection ?? initialError;
  const linked = holdingId !== null;
  const value = (name: string) => initialValues[name] ?? "";
  const named = (name: string) =>
    accessibleSuffix === undefined ? {} : { "aria-label": `${name}${accessibleSuffix}` };

  const onSubmit = readOnly
    ? undefined
    : (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        submitIncomeMutation({
          action,
          formData,
          inFlight,
          onRejection: setRejection,
          plan: () =>
            planIncomeSubmit({
              formData,
              holdingId,
              newId: () => `pending:${crypto.randomUUID()}`,
              today,
            }),
          showOptimistic: applyOptimistic ?? applyPendingRow,
          startTransition,
        });
      };

  return (
    <form
      action={action as (formData: FormData) => void | Promise<void>}
      className="stackForm incomeForm"
      onSubmit={onSubmit}
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <h4>{title}</h4>
      {error ? (
        <p className="formError" role="alert">
          {error}
        </p>
      ) : null}
      <div className="cobrosFormGrid">
        <label>
          Concepto
          <input
            {...named("Concepto")}
            aria-required="true"
            autoComplete="off"
            defaultValue={value("label")}
            name="label"
            placeholder={linked ? "Alquiler, cupón…" : "Pensión, nómina…"}
          />
        </label>
        <label>
          Importe
          <input
            {...named("Importe")}
            aria-required="true"
            defaultValue={value("amount")}
            inputMode="decimal"
            name="amount"
            placeholder="0,00"
          />
        </label>
        <label>
          Cadencia
          <select defaultValue={value("cadence") || "monthly"} name="cadence">
            {PAYOUT_CADENCE_LABELS.map(({ cadence, label }) => (
              <option key={cadence} value={cadence}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Desde
          <input defaultValue={value("startISO") || today} name="startISO" type="date" />
        </label>
        <label>
          Hasta (opcional)
          <input
            {...named("Fecha de fin")}
            defaultValue={value("endISO")}
            name="endISO"
            type="date"
          />
        </label>
        {linked ? (
          <label>
            Gastos (opcional)
            <input
              {...named("Gastos")}
              defaultValue={value("expenses")}
              inputMode="decimal"
              name="expenses"
              placeholder="misma cadencia"
            />
          </label>
        ) : null}
        {linked && showLeaseTerms ? <LeaseTermFields values={null} /> : null}
      </div>
      {linked ? (
        <p className="incomeChoiceNote">
          Los gastos van en la misma cadencia que el importe (comunidad, IBI, seguro,
          agencia, mantenimiento…). Con naturaleza pasiva e importe en euros de hoy
          declarados, si es un inmueble alquilado tu FIRE usará el
          <strong> alquiler neto</strong> sobre su valor como rentabilidad real en vez del
          retorno por defecto de su tramo. Sin gastos declarados no se usa el bruto: se
          queda ese retorno por defecto.
        </p>
      ) : (
        <p className="incomeChoiceNote">
          Una fecha de inicio futura es la forma correcta de una pensión que aún no
          cobras: se guarda tal cual, sin inventar cobros hasta que llegue.
        </p>
      )}
      <IncomeDeclarationInputs linked={linked} values={initialValues} />
      <div className="formActions">
        <button aria-busy={isPending} disabled={isPending} type="submit">
          {isPending ? "Guardando…" : submitLabel}
        </button>
      </div>
      {/* The saving state, announced (§8). The outcome rides the page's band. */}
      <p aria-live="polite" className="srOnly">
        {isPending ? "Guardando…" : ""}
      </p>
      {pendingRows.length > 0 ? (
        <ul className="incomePendingList">
          {pendingRows.map((row) => (
            <li key={row.id}>
              <strong>{row.label}</strong> · guardando…
              <IncomeDeclarationSummary income={row} today={today} />
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

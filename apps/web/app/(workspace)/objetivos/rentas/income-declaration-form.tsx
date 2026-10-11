"use client";

/**
 * The declaration door of an income (#1673, S2 of #1522) — ONE form, two places:
 * the Rentas surface, where an income needs no asset, and a holding's Cobros
 * section, where the asset is already linked (and the form also offers the costs
 * and, for a rented property, the lease terms the ficha always had).
 *
 * The submit is optimistic (interaction-patterns §4/§7): the same parser the server
 * runs decides here, before any round-trip, whether the declaration is refused —
 * the reason shows at once, beside the form, with everything typed still in place —
 * or becomes a row. The row is handed to the list that owns it (`onOptimisticAdd`,
 * the Rentas ledger) or, on a ficha whose list is server-rendered, shown under the
 * form until the redirect brings the real one. The terminals are split (#1311): a
 * refusal the server returns comes back as state, never through a navigation that
 * could be discarded with the reason in it. In demo the form posts plainly and fakes
 * nothing (§10). Without JavaScript it is a plain form post with the redirect
 * terminal, and a refusal refills it from the URL.
 */

import { PAYOUT_CADENCE_LABELS } from "@web/patrimonio/[id]/editar/_surfaces/cobros-form";
import { LeaseTermFields } from "@web/patrimonio/[id]/editar/_surfaces/lease-term-fields";
import type { CurrencyCode, Income } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import { type FormEvent, useOptimistic, useRef, useState, useTransition } from "react";
import { IncomeDeclarationFields } from "./income-declaration-fields";
import { incomeCountingStatus } from "./income-view";
import {
  type IncomeActionResult,
  planIncomeSubmit,
  rejectionOf,
} from "./optimistic-incomes";

export interface IncomeDeclarationFormProps {
  /**
   * Appended to the accessible names of the recurrence fields where another form on
   * the same page has fields with the same visible labels — the ficha's one-off
   * payout form also asks for an «Importe». Absent: the visible labels are the names.
   */
  accessibleSuffix?: string;
  /** The bound create action: redirects on success, hands a refusal back otherwise. */
  action: (formData: FormData) => IncomeActionResult | Promise<IncomeActionResult>;
  currency: CurrencyCode;
  currentUrl: string;
  /** The holding the income is linked to (a ficha), or null (the Rentas surface). */
  holdingId: string | null;
  /** A refusal a no-JS post brought back on the URL, with what it had typed. */
  initialError: string | null;
  initialValues: Readonly<Record<string, string>>;
  /** The ledger's optimistic setter. Absent: the form shows its own pending row. */
  onOptimisticAdd?: (draft: Income) => void;
  privacyMode: boolean;
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
  currency,
  currentUrl,
  holdingId,
  initialError,
  initialValues,
  onOptimisticAdd,
  privacyMode,
  readOnly,
  showLeaseTerms,
  submitLabel,
  title,
  today,
}: IncomeDeclarationFormProps) {
  const [rejection, setRejection] = useState<string | null>(null);
  const [pendingRows, addPendingRow] = useOptimistic(
    [] as readonly Income[],
    (current: readonly Income[], draft: Income) => [...current, draft],
  );
  const [isPending, startTransition] = useTransition();
  // A submit already in flight. A ref, not state: two clicks inside one frame both
  // reach the handler before `isPending` flips, and only a ref sees the first.
  const inFlight = useRef(false);
  const error = rejection ?? initialError;
  const linked = holdingId !== null;
  const value = (name: string) => initialValues[name] ?? "";
  const named = (name: string) =>
    accessibleSuffix === undefined ? {} : { "aria-label": `${name}${accessibleSuffix}` };
  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);

  const onSubmit = readOnly
    ? undefined
    : (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (inFlight.current) return;
        const formData = new FormData(event.currentTarget);
        const plan = planIncomeSubmit({
          formData,
          holdingId,
          newId: () => `pending:${crypto.randomUUID()}`,
          today,
        });
        if (plan.kind === "reject") {
          setRejection(plan.error);
          return;
        }
        // Ask for a refusal as returned state (#1311). Stamped here, never in the
        // HTML, so a no-JS post keeps the redirect terminal it can render.
        formData.set("inlineError", "1");
        setRejection(null);
        inFlight.current = true;
        startTransition(async () => {
          (onOptimisticAdd ?? addPendingRow)(plan.draft);
          try {
            setRejection(rejectionOf(await action(formData)));
          } finally {
            inFlight.current = false;
          }
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
      <IncomeDeclarationFields
        values={{
          nature: value("nature"),
          amountBasis: value("amountBasis"),
          provenance: value("provenance"),
          provenanceAsOf: value("provenanceAsOf"),
          assumedContributionThrough: value("assumedContributionThrough"),
        }}
      />
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
              <strong>{row.label}</strong> · {fmt(row.amountMinor)} · guardando…{" "}
              <span className="incomeStatus">
                {incomeCountingStatus(row, today).text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

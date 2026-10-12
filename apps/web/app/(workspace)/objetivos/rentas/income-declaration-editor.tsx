"use client";

/**
 * The correction of one income (#1673): nature, basis, provenance + cut-off,
 * condition. An income with no asset is corrected whole (#1813) — concept, amount,
 * cadence, start and end too, which is how a life annuity is ended or a pension
 * takes a new simulation's amount: it has no ficha, and no figure derives its past
 * payouts. A linked income's recurrence stays with its ficha's affordances (end,
 * exclusions), because its payouts are derived from it.
 *
 * Optimistic like the door, through the same pure `submitIncomeMutation`: the
 * row's declaration and counting status change the moment the correction leaves,
 * and revert with the reason beside the form if the server refuses it (#1311 split
 * terminal). Saving requires the provenance exactly as declaring does, so an
 * income from before the door gains one the first time it is corrected.
 */

import { IncomeDeclarationInputs } from "@web/_income/income-declaration-inputs";
import { declarationValuesOf, recurrenceValuesOf } from "@web/_income/income-form";
import { IncomeRecurrenceInputs } from "@web/_income/income-recurrence-inputs";
import {
  type IncomeAction,
  type IncomeMutation,
  planDeclarationUpdate,
  submitIncomeMutation,
} from "@web/_income/optimistic-incomes";
import type { Income } from "@worthline/domain";
import { type FormEvent, useRef, useState, useTransition } from "react";

export function IncomeDeclarationEditor({
  action,
  applyOptimistic,
  currentUrl,
  income,
  readOnly,
  today,
}: {
  action: IncomeAction;
  applyOptimistic: (mutation: IncomeMutation) => void;
  currentUrl: string;
  income: Income;
  readOnly: boolean;
  today: string;
}) {
  const [rejection, setRejection] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inFlight = useRef(false);
  // No asset generates it: no ficha holds its recurrence, so this form does.
  const standalone = income.holdingId === null;

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
          plan: () => planDeclarationUpdate({ formData, today }),
          showOptimistic: applyOptimistic,
          startTransition,
        });
      };

  return (
    <form
      action={action as (formData: FormData) => void | Promise<void>}
      className="stackForm incomeEditor"
      onSubmit={onSubmit}
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="incomeId" type="hidden" value={income.id} />
      {rejection ? (
        <p className="formError" role="alert">
          {rejection}
        </p>
      ) : null}
      {standalone ? (
        <>
          {/* The marker that the recurrence travels: an emptied «Hasta» then reads
              as «sin fin», never as a field the form did not carry. */}
          <input name="saveRecurrence" type="hidden" value="1" />
          <div className="cobrosFormGrid">
            <IncomeRecurrenceInputs
              accessibleSuffix={` de ${income.label}`}
              linked={false}
              today={today}
              values={recurrenceValuesOf(income)}
            />
          </div>
          <p className="incomeChoiceNote">
            Para terminarla, pon en «Hasta» la fecha de su último cobro; vaciarlo la
            reactiva. Si el importe cambia porque tienes una cifra nueva, cambia también
            de dónde sale y su fecha de corte.
          </p>
        </>
      ) : null}
      <IncomeDeclarationInputs
        linked={!standalone}
        values={declarationValuesOf(income)}
      />
      <div className="formActions">
        <button
          aria-busy={isPending}
          className="btnSmall"
          disabled={isPending}
          type="submit"
        >
          {isPending
            ? "Guardando…"
            : standalone
              ? "Guardar renta"
              : "Guardar declaración"}
        </button>
      </div>
      {/* The saving state, announced (§8), like the door and the delete. */}
      <p aria-live="polite" className="srOnly">
        {isPending ? "Guardando…" : ""}
      </p>
    </form>
  );
}

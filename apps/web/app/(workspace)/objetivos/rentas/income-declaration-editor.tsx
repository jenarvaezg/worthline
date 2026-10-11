"use client";

/**
 * «Corregir la declaración» of one income (#1673): nature, basis, provenance +
 * cut-off, condition — never the recurrence, whose amendments belong to the ficha's
 * affordances (end, exclusions) because they re-derive past payouts.
 *
 * Optimistic like the door, through the same pure `submitIncomeMutation`: the
 * row's declaration and counting status change the moment the correction leaves,
 * and revert with the reason beside the form if the server refuses it (#1311 split
 * terminal). Saving requires the provenance exactly as declaring does, so an
 * income from before the door gains one the first time it is corrected.
 */

import { IncomeDeclarationInputs } from "@web/_income/income-declaration-inputs";
import { declarationValuesOf } from "@web/_income/income-form";
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
      <IncomeDeclarationInputs
        linked={income.holdingId !== null}
        values={declarationValuesOf(income)}
      />
      <div className="formActions">
        <button
          aria-busy={isPending}
          className="btnSmall"
          disabled={isPending}
          type="submit"
        >
          {isPending ? "Guardando…" : "Guardar declaración"}
        </button>
      </div>
      {/* The saving state, announced (§8), like the door and the delete. */}
      <p aria-live="polite" className="srOnly">
        {isPending ? "Guardando…" : ""}
      </p>
    </form>
  );
}

"use client";

/**
 * «Corregir la declaración» of one income (#1673): nature, basis, provenance +
 * cut-off, condition — never the recurrence, whose amendments belong to the ficha's
 * affordances (end, exclusions) because they re-derive past payouts.
 *
 * Optimistic like the door: the row's declaration and counting status change the
 * moment the correction leaves, and revert with the reason beside the form if the
 * server refuses it (#1311 split terminal). Saving requires the provenance exactly
 * as declaring does, so an income from before the door gains one the first time it
 * is corrected.
 */

import type { Income } from "@worthline/domain";
import { type FormEvent, useRef, useState, useTransition } from "react";
import { IncomeDeclarationFields } from "./income-declaration-fields";
import {
  type IncomeActionResult,
  type IncomeMutation,
  planDeclarationUpdate,
  rejectionOf,
} from "./optimistic-incomes";

export function IncomeDeclarationEditor({
  action,
  currentUrl,
  income,
  onOptimistic,
  readOnly,
  today,
}: {
  action: (formData: FormData) => IncomeActionResult | Promise<IncomeActionResult>;
  currentUrl: string;
  income: Income;
  onOptimistic: (mutation: IncomeMutation) => void;
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
        if (inFlight.current) return;
        const formData = new FormData(event.currentTarget);
        const plan = planDeclarationUpdate({ formData, today });
        if (plan.kind === "reject") {
          setRejection(plan.error);
          return;
        }
        formData.set("inlineError", "1");
        setRejection(null);
        inFlight.current = true;
        startTransition(async () => {
          onOptimistic({ kind: "update", id: plan.id, declaration: plan.declaration });
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
      <IncomeDeclarationFields
        values={{
          nature: income.nature ?? "",
          amountBasis: income.amountBasis ?? "",
          provenance: income.provenance ?? "",
          provenanceAsOf: income.provenanceAsOf ?? "",
          assumedContributionThrough: income.assumedContributionThrough ?? "",
        }}
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
    </form>
  );
}

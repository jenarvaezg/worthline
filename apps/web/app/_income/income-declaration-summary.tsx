/**
 * What every declared income says about itself, wherever it is listed (#1673): a
 * word and a sentence on whether it counts — and why not when it does not — then
 * what it declares, where its figure comes from and the condition it rests on.
 *
 * One component for the Rentas list and the holding's Cobros section, so the two
 * can never print the same income two different ways. No hooks: it renders in a
 * server section and in a client island alike.
 */

import type { Income } from "@worthline/domain";
import type { ReactNode } from "react";
import {
  incomeConditionLine,
  incomeCountingStatus,
  incomeDeclarationLine,
  incomeProvenanceLine,
} from "./income-view";

export function IncomeDeclarationSummary({
  children,
  holdingInTrash = false,
  income,
  today,
}: {
  /** Appended to the declaration line — e.g. the ficha's link to correct it on Rentas. */
  children?: ReactNode;
  holdingInTrash?: boolean;
  income: Income;
  today: string;
}) {
  const status = incomeCountingStatus(income, today, { holdingInTrash });
  const condition = incomeConditionLine(income);
  return (
    <>
      <p className={status.counts ? "incomeStatus" : "incomeStatus incomeStatusOff"}>
        <span className="incomeStatusMark">{status.mark}</span> {status.text}
      </p>
      <p className="cobrosCap">
        {incomeDeclarationLine(income)} · {incomeProvenanceLine(income)}
        {condition ? ` · ${condition}` : ""}
        {children}
      </p>
    </>
  );
}

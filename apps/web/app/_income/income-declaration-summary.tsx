/**
 * What every declared income says about itself, wherever it is listed (#1673): a
 * word and a sentence on whether it counts — and why not when it does not — then
 * what it declares, where its figure comes from and the condition it rests on.
 *
 * One component for the Rentas list and the holding's Cobros section, so the two
 * can never print the same income two different ways. No hooks: it renders in a
 * server section and in a client island alike.
 *
 * An income without an asset only gets its counting line from a surface that says
 * which scope it is looking at (#1811): whether the card reads it is that scope's
 * answer, and without one this prints nothing rather than a guess.
 */

import type { Income, StandaloneIncomeCardContext } from "@worthline/domain";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  incomeConditionLine,
  incomeCountingStatus,
  incomeDeclarationLine,
  incomeProvenanceLine,
} from "./income-view";

export function IncomeDeclarationSummary({
  cardContext,
  children,
  holdingInTrash = false,
  income,
  today,
}: {
  /** Appended to the declaration line — e.g. the ficha's link to correct it on Rentas. */
  children?: ReactNode;
  holdingInTrash?: boolean;
  income: Income;
  /** The scope on screen, as the sustainable-spending card sees it. */
  cardContext?: StandaloneIncomeCardContext;
  today: string;
}) {
  const status = incomeCountingStatus(income, today, {
    holdingInTrash,
    ...(cardContext === undefined ? {} : { cardContext }),
  });
  const condition = incomeConditionLine(income);
  return (
    <>
      {status ? (
        <p className={status.counts ? "incomeStatus" : "incomeStatus incomeStatusOff"}>
          <span className="incomeStatusMark">{status.mark}</span> {status.text}
          {status.fix ? (
            <>
              {" "}
              <Link href={status.fix.href}>{status.fix.label}</Link>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="cobrosCap">
        {incomeDeclarationLine(income)} · {incomeProvenanceLine(income)}
        {condition ? ` · ${condition}` : ""}
        {children}
      </p>
    </>
  );
}

"use client";

/**
 * The Rentas ledger (#1673, S2 of #1522): every declared income in one list — the
 * ones no asset generates, which have no ficha to live on, and the ones a holding
 * generates — with the door to declare a new one underneath.
 *
 * A client island only for the optimism (interaction-patterns §4/§7): declaring,
 * correcting and deleting fold over the server's list through the pure
 * `applyIncomeMutations`, and every row says, from the same pure view the server
 * would use, whether it is counting and why not. Nothing here is a server-computed
 * figure: the rows are declarations, so the optimistic one is the stored one. In
 * demo the forms post plainly and nothing is faked (§10).
 */

import type { CurrencyCode, Income } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import { type FormEvent, useOptimistic, useTransition } from "react";
import { IncomeDeclarationEditor } from "./income-declaration-editor";
import { IncomeDeclarationForm } from "./income-declaration-form";
import {
  incomeConditionLine,
  incomeCountingStatus,
  incomeDeclarationLine,
  incomeProvenanceLine,
  incomeWindowLine,
  sortIncomesForDisplay,
} from "./income-view";
import type { IncomeHolding } from "./load-rentas";
import {
  applyIncomeMutations,
  type IncomeActionResult,
  type IncomeMutation,
} from "./optimistic-incomes";

type IncomeAction = (
  formData: FormData,
) => IncomeActionResult | Promise<IncomeActionResult>;

/** An optimistic row's key: it has no stored id yet, so it offers no actions. */
const isPendingRow = (income: Income) => income.id.startsWith("pending:");

export function IncomesLedger({
  createAction,
  currency,
  currentUrl,
  deleteAction,
  holdingById,
  incomes,
  initialError,
  initialValues,
  privacyMode,
  readOnly,
  today,
  updateAction,
}: {
  createAction: IncomeAction;
  currency: CurrencyCode;
  currentUrl: string;
  deleteAction: (formData: FormData) => void | Promise<void>;
  holdingById: Readonly<Record<string, IncomeHolding>>;
  incomes: readonly Income[];
  /** A refused no-JS declaration, brought back on the URL with what it typed. */
  initialError: string | null;
  initialValues: Readonly<Record<string, string>>;
  privacyMode: boolean;
  readOnly: boolean;
  today: string;
  updateAction: IncomeAction;
}) {
  const [optimistic, addPending] = useOptimistic(
    incomes,
    (current: readonly Income[], mutation: IncomeMutation) =>
      applyIncomeMutations(current, [mutation]),
  );
  const [isDeleting, startDeleting] = useTransition();
  const rows = sortIncomesForDisplay(optimistic);
  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);

  const onDelete = (id: string) =>
    readOnly
      ? undefined
      : (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          startDeleting(async () => {
            addPending({ kind: "delete", id });
            await deleteAction(formData);
          });
        };

  return (
    <>
      <section aria-label="Tus rentas declaradas" className="section">
        <div className="panelHeader">
          <h3>Tus rentas</h3>
          <span>
            {rows.length} {rows.length === 1 ? "renta" : "rentas"}
          </span>
        </div>
        <p aria-live="polite" className="srOnly">
          {isDeleting ? "Guardando…" : ""}
        </p>

        {rows.length === 0 ? (
          <p className="muted">
            Aún no has declarado ninguna renta. Una pensión, una nómina o una renta
            vitalicia no son activos: decláralas aquí abajo, sin darlas de alta en tu
            patrimonio.
          </p>
        ) : (
          <ul className="incomeList">
            {rows.map((income) => {
              const status = incomeCountingStatus(income, today);
              const condition = incomeConditionLine(income);
              const holding =
                income.holdingId === null ? null : holdingById[income.holdingId];
              const pending = isPendingRow(income);
              return (
                <li className="incomeRow" key={income.id}>
                  <div className="incomeRowTop">
                    <div className="incomeRowMeta">
                      <strong>{income.label}</strong>
                      <span className="cobrosCap">{incomeWindowLine(income)}</span>
                      <span className="cobrosCap">
                        {income.holdingId === null ? (
                          "Sin activo"
                        ) : holding?.href ? (
                          <>
                            Generada por <Link href={holding.href}>{holding.name}</Link>
                          </>
                        ) : (
                          `Generada por ${holding?.name ?? "un activo que está en la papelera"}`
                        )}
                      </span>
                    </div>
                    <span className="incomeRowAmount">{fmt(income.amountMinor)}</span>
                  </div>
                  <p
                    className={
                      status.counts ? "incomeStatus" : "incomeStatus incomeStatusOff"
                    }
                  >
                    <span className="incomeStatusMark">{status.mark}</span> {status.text}
                  </p>
                  <p className="cobrosCap">
                    {incomeDeclarationLine(income)} · {incomeProvenanceLine(income)}
                    {condition ? ` · ${condition}` : ""}
                  </p>
                  {pending ? (
                    <p className="cobrosCap">Guardando…</p>
                  ) : (
                    <div className="incomeRowActions">
                      <details className="incomeCorrect" suppressHydrationWarning>
                        <summary>Corregir la declaración</summary>
                        <IncomeDeclarationEditor
                          action={updateAction}
                          currentUrl={currentUrl}
                          income={income}
                          onOptimistic={addPending}
                          readOnly={readOnly}
                          today={today}
                        />
                      </details>
                      <form action={deleteAction} onSubmit={onDelete(income.id)}>
                        <input name="currentUrl" type="hidden" value={currentUrl} />
                        <input name="incomeId" type="hidden" value={income.id} />
                        <button
                          aria-label={`Eliminar ${income.label}`}
                          className="btnSmall btnWarning"
                          type="submit"
                        >
                          Eliminar
                        </button>
                      </form>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Declarar una renta" className="section">
        <IncomeDeclarationForm
          action={createAction}
          currency={currency}
          currentUrl={currentUrl}
          holdingId={null}
          initialError={initialError}
          initialValues={initialValues}
          onOptimisticAdd={(draft) => addPending({ kind: "add", income: draft })}
          privacyMode={privacyMode}
          readOnly={readOnly}
          showLeaseTerms={false}
          submitLabel="Guardar renta"
          title="Declarar una renta"
          today={today}
        />
      </section>
    </>
  );
}

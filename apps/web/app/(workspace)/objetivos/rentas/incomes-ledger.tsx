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
 *
 * Why the whole list is client (§11): every row is a target of the fold — a
 * correction re-words its status, a delete removes it, a declaration inserts one in
 * sorted place — so a server list with client patches would need the same row
 * markup twice. The rows carry only pure formatting (the shared summary, the window
 * line, the money formatter); no figure is computed here.
 */

import { IncomeDeclarationForm } from "@web/_income/income-declaration-form";
import { IncomeDeclarationSummary } from "@web/_income/income-declaration-summary";
import { incomeWindowLine, sortIncomesForDisplay } from "@web/_income/income-view";
import {
  applyIncomeMutations,
  type IncomeAction,
  type IncomeMutation,
} from "@web/_income/optimistic-incomes";
import type {
  CurrencyCode,
  Income,
  StandaloneIncomeCardContext,
} from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import { type FormEvent, useOptimistic, useTransition } from "react";
import { IncomeDeclarationEditor } from "./income-declaration-editor";
import type { IncomeHolding } from "./load-rentas";

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
  cardContext,
  readOnly,
  today,
  updateAction,
}: {
  createAction: IncomeAction;
  currency: CurrencyCode;
  currentUrl: string;
  deleteAction: (formData: FormData) => void | Promise<void>;
  /** The LIVE holdings incomes link to; a linked id missing here is in the Papelera. */
  holdingById: Readonly<Record<string, IncomeHolding>>;
  incomes: readonly Income[];
  /** A refused no-JS declaration, brought back on the URL with what it typed. */
  initialError: string | null;
  initialValues: Readonly<Record<string, string>>;
  privacyMode: boolean;
  readOnly: boolean;
  /**
   * The scope on screen, as the sustainable-spending card sees it (#1811): whether
   * the card reads an income without an asset is its answer, and a row declared a
   * second ago has to be told the same answer the server would give.
   */
  cardContext: StandaloneIncomeCardContext;
  today: string;
  updateAction: IncomeAction;
}) {
  // Declarations, corrections and deletions all fold here before the server answers.
  const [optimistic, applyOptimistic] = useOptimistic(
    incomes,
    (current: readonly Income[], mutation: IncomeMutation) =>
      applyIncomeMutations(current, [mutation]),
  );
  const [isDeleting, startDeleting] = useTransition();
  // Sorted once, here, after the fold — so an optimistic row lands where the
  // stored one will be.
  const rows = sortIncomesForDisplay(optimistic);

  const onDelete = (id: string) =>
    readOnly
      ? undefined
      : (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          startDeleting(async () => {
            applyOptimistic({ kind: "delete", id });
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
              const holding =
                income.holdingId === null
                  ? null
                  : (holdingById[income.holdingId] ?? null);
              const holdingInTrash = income.holdingId !== null && holding === null;
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
                          `Generada por ${holding?.name ?? "un activo que está en la Papelera"}`
                        )}
                      </span>
                    </div>
                    <span className="incomeRowAmount">
                      {formatMoneyMinorPrivacy(
                        { amountMinor: income.amountMinor, currency },
                        privacyMode,
                      )}
                    </span>
                  </div>
                  <IncomeDeclarationSummary
                    holdingInTrash={holdingInTrash}
                    income={income}
                    cardContext={cardContext}
                    today={today}
                  />
                  {isPendingRow(income) ? (
                    <p className="cobrosCap">Guardando…</p>
                  ) : (
                    <div className="incomeRowActions">
                      <details className="incomeCorrect" suppressHydrationWarning>
                        {/* With no asset it is corrected whole (#1813): ending it is
                            giving it an end, so the summary names it. */}
                        <summary>
                          {income.holdingId === null
                            ? "Corregir o terminar"
                            : "Corregir la declaración"}
                        </summary>
                        <IncomeDeclarationEditor
                          action={updateAction}
                          applyOptimistic={applyOptimistic}
                          currentUrl={currentUrl}
                          income={income}
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
          applyOptimistic={applyOptimistic}
          currentUrl={currentUrl}
          holdingId={null}
          initialError={initialError}
          initialValues={initialValues}
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

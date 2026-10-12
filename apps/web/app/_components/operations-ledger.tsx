"use client";

/**
 * The ledger of an investment's operations (#152, ADR 0006/0014), as the ficha's
 * «Operaciones» tab: every apunte, newest first, compact (#1827).
 *
 * - One row per apunte, about 35 px: Fecha · Tipo · Participaciones · Precio ·
 *   Comisión · Importe · «⋯». The importe is the domain's (`operationAmountMinor`),
 *   never a multiplication here; the figures are Iosevka tabular, right-aligned.
 * - The 10 latest on show; «Ver las N operaciones» unfolds the rest in place, a view
 *   toggle with no round trip (interaction-patterns §2) mirrored in the URL as
 *   `?libro=todas` (§3), so a delete's terminal, a reload and Back all keep it. Which
 *   rows show is the pure `ledgerRowsOnShow`.
 * - On a phone each row reads in two lines with no sideways scroll: «12/09/2026 ·
 *   Compra» with the importe at the right, and «5 × 106,65 € · comisión 1 €» under it.
 *   It is still one `<tr>` per apunte; CSS lays it out.
 * - «Eliminar» lives inside «⋯», still a two-step confirmation.
 *
 * The record form lives in the side panel; both reach one optimistic list through
 * `OperationsBookProvider`, so a row being recorded shows here before its action
 * resolves and a row being deleted vanishes at once (#521, interaction-patterns §4).
 * In demo (`readOnly`) the delete posts plainly and fakes nothing (§10).
 */

import type { TransferRowCounterpart } from "@web/operation-kind-copy";
import { pushMirroredUrl } from "@web/url-view-state";
import { writeViewParam } from "@web/view-state";
import { compareInvestmentOperations } from "@worthline/domain";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useId, useTransition } from "react";
import { useFreshRows } from "./fresh-rows";
import { useOperationsBook } from "./operations-book";
import {
  LEDGER_VIEW_PARAM,
  ledgerReturnUrl,
  ledgerRowsOnShow,
  readLedgerRow,
  readLedgerScope,
} from "./operations-ledger-view";

export function OperationsLedger({
  currentUrl,
  deleteAction,
  freshIds,
  privacyMode = false,
  readOnly = false,
  transferCounterparts,
}: {
  /** Where the delete's terminal returns: the ficha, on this tab. */
  currentUrl: string;
  deleteAction: (formData: FormData) => void | Promise<void>;
  /**
   * The ids of the rows just recorded (#1829): each is marked, and shows even when it
   * sorts past the tenth. Absent, they are the ones the ficha's last render added
   * (`useFreshRows`) — none outside a ficha.
   */
  freshIds?: ReadonlySet<string>;
  privacyMode?: boolean;
  /** Demo: skip optimistic state — the write-guard rejects, so optimism would flicker (§10). */
  readOnly?: boolean;
  /**
   * Where each traspaso half's OTHER half lives (#1481), keyed by operation id —
   * server-resolved via `transferCounterpartByOperationId`. Absent entries (or an
   * absent map: an optimistic row, a caller that has none) claim nothing about the
   * counterpart; the row still prints its kind and, on a `transfer_in`, its
   * inherited cost.
   */
  transferCounterparts?: Record<string, TransferRowCounterpart>;
}) {
  const { addPending, operations } = useOperationsBook();
  const fichaFresh = useFreshRows("operaciones");
  const freshRows = freshIds ?? fichaFresh;
  const [isDeleting, startDeleting] = useTransition();
  // Unfolded or not is the URL's (`?libro=todas`), read from it and never held beside
  // it: a delete's terminal remounts the ledger, and it has to come back as it was.
  const scope = readLedgerScope(useSearchParams()?.toString() ?? "");
  const returnUrl = ledgerReturnUrl(currentUrl, scope);
  const bodyId = useId();

  const toggleScope = () => {
    const { hash, pathname, search } = window.location;
    const next = scope === "todas" ? "recientes" : "todas";
    pushMirroredUrl(
      `${pathname}${writeViewParam(search, LEDGER_VIEW_PARAM, next)}${hash}`,
    );
  };

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

  const { shown, toggle } = ledgerRowsOnShow(
    [...operations].sort((a, b) => compareInvestmentOperations(b, a)),
    scope === "todas",
    (op) => freshRows.has(op.id),
  );

  return (
    // The anchor `holdingOperationsHref` lands on (#1365): the operations, on show.
    <section aria-label="Operaciones de la inversión" id="operaciones">
      {/* Announce the in-flight delete for screen readers (§8), outside any row
          the optimism removes. */}
      <p aria-live="polite" className="srOnly">
        {isDeleting ? "Guardando…" : ""}
      </p>

      {operations.length === 0 ? (
        <p className="emptyLine">Todavía no hay operaciones.</p>
      ) : (
        <div className="recentOpsPanel opsLedger">
          <table>
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Tipo</th>
                <th className="opsNum" scope="col">
                  Participaciones
                </th>
                <th className="opsNum" scope="col">
                  Precio
                </th>
                <th className="opsNum" scope="col">
                  Comisión
                </th>
                <th className="opsNum" scope="col">
                  Importe
                </th>
                <th className="opsMenu" scope="col">
                  <span className="srOnly">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody id={bodyId}>
              {shown.map((op) => {
                const row = readLedgerRow(op, {
                  counterpart: transferCounterparts?.[op.id] ?? { kind: "unresolved" },
                  privacyMode,
                });
                const fresh = freshRows.has(op.id);

                return (
                  <tr data-fresh={fresh ? "" : undefined} key={op.id}>
                    <td className="opsDate">{row.date}</td>
                    <td className="opsKind">
                      {row.kind}
                      {/* Said in words, not only tinted (#1829): colour is never the
                          only signal. */}
                      {fresh ? <small className="fichaFreshMark">nueva</small> : null}
                      {row.note ? (
                        <small className="opCaptureNote">{row.note}</small>
                      ) : null}
                    </td>
                    <td className="opsNum opsSplit">{row.units}</td>
                    <td className="opsNum opsSplit">
                      {row.price}
                      {row.priceCapture ? (
                        <small className="opCaptureNote">{row.priceCapture}</small>
                      ) : null}
                    </td>
                    <td className="opsNum opsSplit">
                      {row.fees ?? "—"}
                      {row.feesCapture ? (
                        <small className="opCaptureNote">{row.feesCapture}</small>
                      ) : null}
                    </td>
                    <td className="opsNum opsAmount">{row.amount}</td>
                    {/* The phone's second line; on a desktop the three cells before
                        say it in columns. */}
                    <td className="opsCalc">{row.calc}</td>
                    <td className="opsMenu">
                      <details suppressHydrationWarning className="balanceActions">
                        <summary aria-label={`Acciones de la operación del ${row.date}`}>
                          ⋯
                        </summary>
                        <div className="balanceMenu">
                          <form action={deleteAction} onSubmit={onDelete(op.id)}>
                            <input name="currentUrl" type="hidden" value={returnUrl} />
                            <input name="operationId" type="hidden" value={op.id} />
                            <details suppressHydrationWarning className="confirmDelete">
                              <summary>Eliminar</summary>
                              {row.isTransfer ? (
                                // The pair leaves the book by one door (ADR 0083):
                                // deleting half deletes the whole traspaso.
                                <small className="opCaptureNote">
                                  Se elimina el traspaso entero: las dos mitades.
                                </small>
                              ) : null}
                              <button type="submit">Confirmar</button>
                            </details>
                          </form>
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {toggle ? (
            <button
              aria-controls={bodyId}
              aria-expanded={toggle.expanded}
              className="btnSecondary btnSmall opsMore"
              onClick={toggleScope}
              type="button"
            >
              {toggle.label}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

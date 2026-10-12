"use client";

/**
 * The ledger of an investment's operations (#152, ADR 0006/0014): every apunte,
 * date desc, each with its two-step delete. Since #1826 it is the ficha's
 * «Operaciones» tab, apart from the record form in the side panel; the two share
 * the optimistic list through `OperationsBookProvider`, so a row being recorded
 * shows here before its action resolves and a row being deleted vanishes at once
 * (#521, interaction-patterns §4). In demo (`readOnly`) the delete posts plainly
 * and fakes nothing (§10).
 *
 * Still the table it has always been; its compact redesign is #1827.
 */

import { formatIsoDayEs } from "@web/asistente/iso-day-es";
import {
  operationKindLabel,
  type TransferRowCounterpart,
  transferRowNote,
} from "@web/operation-kind-copy";
import {
  compareInvestmentOperations,
  formatMoneyMinorPrivacy,
  formatUnits,
  isTransferKind,
} from "@worthline/domain";
import { type FormEvent, useTransition } from "react";
import { useFreshRows } from "./fresh-rows";
import { readOperationFees, readOperationPrice } from "./operation-capture-reading";
import { useOperationsBook } from "./operations-book";

export function OperationsLedger({
  currentUrl,
  deleteAction,
  privacyMode = false,
  readOnly = false,
  transferCounterparts,
}: {
  /** Where the delete's terminal returns: the ficha, on this tab. */
  currentUrl: string;
  deleteAction: (formData: FormData) => void | Promise<void>;
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
  // The row a terminal just added, pointed at (#1829): «la fila nueva sale destacada».
  const fresh = useFreshRows("operaciones");
  const [isDeleting, startDeleting] = useTransition();

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
        <div className="recentOpsPanel tableScroll">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Unidades</th>
                <th>Precio/u</th>
                <th>Comisiones</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...operations]
                .sort((a, b) => compareInvestmentOperations(b, a))
                .map((op) => {
                  const price = readOperationPrice(op, privacyMode);
                  const fees = readOperationFees(op, privacyMode);
                  // The traspaso half reads as one move with an origin and a
                  // destination (#1481) — never as a loose sale or buy.
                  const transferNote = transferRowNote({
                    counterpart: transferCounterparts?.[op.id] ?? {
                      kind: "unresolved",
                    },
                    kind: op.kind,
                    privacyMode,
                    ...(op.transferCostMinor !== undefined
                      ? { transferCostMinor: op.transferCostMinor }
                      : {}),
                    // The declared inherited seniority (#1518). Shown so it can be
                    // CHECKED: nothing computes on it yet, and a year typed wrong
                    // that nobody can see is one nobody can correct.
                    ...(op.transferSeniorityAt !== undefined
                      ? { transferSeniorityAt: op.transferSeniorityAt }
                      : {}),
                  });

                  return (
                    <tr data-fresh={fresh.has(op.id) ? "" : undefined} key={op.id}>
                      <td>{formatIsoDayEs(op.executedAt)}</td>
                      <td>
                        {operationKindLabel(op.kind)}
                        {/* Said in words too: the tint alone is not a reading. */}
                        {fresh.has(op.id) ? (
                          <small className="fichaFreshMark">nueva</small>
                        ) : null}
                        {transferNote ? (
                          <small className="opCaptureNote">{transferNote}</small>
                        ) : null}
                      </td>
                      <td>{formatUnits(op.units)}</td>
                      <td>
                        {price.price}
                        {price.capture ? (
                          <small className="opCaptureNote">{price.capture}</small>
                        ) : null}
                      </td>
                      <td>
                        {fees === null ? (
                          "—"
                        ) : (
                          <>
                            {formatMoneyMinorPrivacy(fees.fees, privacyMode)}
                            {fees.capture ? (
                              <small className="opCaptureNote">{fees.capture}</small>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className="rowActions">
                        <form action={deleteAction} onSubmit={onDelete(op.id)}>
                          <input name="currentUrl" type="hidden" value={currentUrl} />
                          <input name="operationId" type="hidden" value={op.id} />
                          <details suppressHydrationWarning className="confirmDelete">
                            <summary>Eliminar</summary>
                            {isTransferKind(op.kind) ? (
                              // The pair leaves the book by one door (ADR 0083):
                              // deleting half deletes the whole traspaso.
                              <small className="opCaptureNote">
                                Se elimina el traspaso entero: las dos mitades.
                              </small>
                            ) : null}
                            <button type="submit">Confirmar</button>
                          </details>
                        </form>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

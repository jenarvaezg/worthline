"use client";

/**
 * Operations editor — the `derived` valuation surface (#152, ADR 0006/0014).
 *
 * Records buy/sell operations, lists them (date desc) with a two-step delete,
 * and shows the derived units / value context. An investment's value is never
 * edited by hand (ADR 0006); the only way to move units is an operation. This is
 * the single component the surface lives in: the unified holding detail
 * (`/patrimonio/[id]/editar`) renders it with already-bound server actions and
 * the data (#153 collapsed the /inversiones routes that once also used it).
 *
 * Optimistic mutations (#521, S5 of #485, interaction-patterns §4/§7/§8). The
 * ADR 0036 client island for operations: recording or deleting an operation
 * updates the list immediately via `useOptimistic` + the pure
 * `applyOperationMutations`, then the action's redirect back to this page settles
 * it (or reverts + shows the error band on failure). Only the operation ROW is
 * faked — the derived units/value/PnL in the context header are server-computed
 * and NOT predictable, so they settle on the redirect (§4). The forms keep their
 * server-action `action=` for no-JS progressive enhancement; `onSubmit` only
 * intercepts when JS is on. Saving is announced via an `aria-live` region (§8),
 * outside any optimistically-removed row. In demo (`readOnly`) the optimism is
 * skipped (§10).
 */

import { formatMoneyMinorPrivacy, maskMoneyString } from "@worthline/domain";
import type { InvestmentOperation, PriceFreshnessState } from "@worthline/domain";
import { useOptimistic, useTransition, type FormEvent } from "react";

import { priceFreshnessLabel } from "@web/intake";
import type { FormErrorContext } from "@web/intake";

import {
  applyOperationMutations,
  parseOperationDraft,
  type OperationMutation,
} from "./optimistic-operations";

export interface OperationsEditorContext {
  /** The current units held, as derived from the operations (PositionView). */
  currentUnits?: string;
  /** The latest cached unit price (string), when one is known. */
  unitPrice?: string;
  /** Freshness of the cached price, for the small status chip. */
  priceFreshness?: PriceFreshnessState | null;
  /**
   * Visible caption with the absolute price-refresh date + source (#303), e.g.
   * "Precio actualizado el 8 jun 2026 · Yahoo". Null/absent for a manual quote.
   */
  priceRefreshCaption?: string | null;
  /** The derived market value (units × price), when priced. */
  marketValue?: { amountMinor: number; currency: string } | null;
  /** The unrealized profit/loss, when priced. */
  unrealizedPnl?: { amountMinor: number; currency: string } | null;
}

/**
 * Render the operations editor for a `derived` holding. `currentUrl` is the page
 * the bound actions return to (so it works identically from either route); the
 * record/delete actions are already bound to the asset id by the caller.
 */
export default function OperationsEditor({
  assetId,
  assetName,
  context,
  currentUrl,
  formError,
  operations,
  privacyMode = false,
  readOnly = false,
  recordAction,
  deleteAction,
  today,
}: {
  /** The holding id the optimistic row is tagged with (the bound actions own it server-side). */
  assetId: string;
  assetName: string;
  context: OperationsEditorContext;
  currentUrl: string;
  formError: FormErrorContext | null;
  operations: readonly InvestmentOperation[];
  privacyMode?: boolean;
  /** Demo: skip optimistic state — the write-guard rejects, so optimism would flicker (§10). */
  readOnly?: boolean;
  recordAction: (formData: FormData) => void | Promise<void>;
  deleteAction: (formData: FormData) => void | Promise<void>;
  today: string;
}) {
  const operationValues = formError?.formId === "operation" ? formError.values : {};

  const [optimisticOps, addPending] = useOptimistic(
    operations,
    (current: readonly InvestmentOperation[], mutation: OperationMutation) =>
      applyOperationMutations(current, [mutation]),
  );
  const [isPending, startTransition] = useTransition();

  // Record: build the optimistic row from the form, apply it, then run the action —
  // all in the transition so `useOptimistic` tracks it and `isPending` holds until
  // the redirect lands. In demo we let the form fall back to its plain `action=`
  // post (no faked optimism, §10).
  const onRecord = readOnly
    ? undefined
    : (event: FormEvent<HTMLFormElement>) => {
        const formData = new FormData(event.currentTarget);
        const draft = parseOperationDraft(formData, assetId, today, crypto.randomUUID());
        if (!draft) {
          return; // let the native post + server validation surface the error
        }
        event.preventDefault();
        startTransition(async () => {
          addPending({ kind: "add", operation: draft });
          await recordAction(formData);
        });
      };

  const onDelete = (id: string) =>
    readOnly
      ? undefined
      : (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          startTransition(async () => {
            addPending({ kind: "delete", id });
            await deleteAction(formData);
          });
        };

  return (
    <section aria-label="Operaciones de la inversión">
      <h3>Operaciones</h3>

      {/* Announce the in-flight save for screen readers (§8); the settled outcome
          rides the page's status band after the redirect. */}
      <p aria-live="polite" className="srOnly">
        {isPending ? "Guardando…" : ""}
      </p>

      {/* Context header: name + derived state — no JS needed to verify a sell */}
      <div className="operacionContext">
        <span className="contextLabel">Inversión</span>
        <strong>{assetName}</strong>
        {context.currentUnits !== undefined ? (
          <>
            <span className="contextLabel">Unidades actuales</span>
            <span>{context.currentUnits}</span>
            {context.unitPrice !== undefined ? (
              <>
                <span className="contextLabel">Último precio</span>
                <span>
                  {context.unitPrice && privacyMode
                    ? maskMoneyString(context.unitPrice)
                    : context.unitPrice}{" "}
                  <small className={`priceStatus ${context.priceFreshness ?? "unknown"}`}>
                    {priceFreshnessLabel(context.priceFreshness ?? null)}
                  </small>
                  {context.priceRefreshCaption ? (
                    <small className="priceRefreshCaption">
                      {context.priceRefreshCaption}
                    </small>
                  ) : null}
                </span>
              </>
            ) : null}
            {context.marketValue ? (
              <>
                <span className="contextLabel">Valor actual</span>
                <span>{formatMoneyMinorPrivacy(context.marketValue, privacyMode)}</span>
              </>
            ) : null}
            {context.unrealizedPnl ? (
              <>
                <span className="contextLabel">P/L latente</span>
                <span
                  className={
                    context.unrealizedPnl.amountMinor >= 0
                      ? "amountPositive"
                      : "amountNegative"
                  }
                >
                  {context.unrealizedPnl.amountMinor > 0 ? "+" : ""}
                  {formatMoneyMinorPrivacy(context.unrealizedPnl, privacyMode)}
                </span>
              </>
            ) : null}
          </>
        ) : (
          <span className="emptyLine">Sin operaciones previas</span>
        )}
      </div>

      {formError?.formId === "operation" ? (
        <p className="errorBand" role="alert" id="operation-error">
          {formError.message}
        </p>
      ) : null}

      <form
        action={recordAction}
        aria-label="Registrar operación"
        className="stackForm inversionesForm"
        onSubmit={onRecord}
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />

        <label>
          Tipo
          <select defaultValue={operationValues["kind"] ?? "buy"} name="kind">
            <option value="buy">Compra</option>
            <option value="sell">Venta</option>
          </select>
        </label>

        <label>
          Fecha
          <input
            aria-label="Fecha de ejecución"
            defaultValue={operationValues["executedAt"] ?? today}
            name="executedAt"
            type="date"
          />
        </label>

        <label>
          Unidades <span aria-hidden="true">*</span>
          <input
            aria-label="Unidades"
            aria-required="true"
            defaultValue={operationValues["units"]}
            inputMode="decimal"
            name="units"
            placeholder="10"
          />
        </label>

        <label>
          Precio por unidad (EUR) <span aria-hidden="true">*</span>
          <input
            aria-label="Precio por unidad en EUR"
            aria-required="true"
            defaultValue={operationValues["pricePerUnit"]}
            inputMode="decimal"
            name="pricePerUnit"
            placeholder="100,00"
          />
        </label>

        <label>
          Comisiones (EUR)
          <input
            aria-label="Comisiones en EUR"
            defaultValue={operationValues["fees"] ?? "0"}
            inputMode="decimal"
            name="fees"
            placeholder="0"
          />
        </label>

        <button type="submit">Registrar operación</button>
      </form>

      {optimisticOps.length > 0 ? (
        <details className="recentOpsPanel" open>
          <summary>Todas las operaciones ({optimisticOps.length})</summary>
          <div className="tableScroll">
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
                {[...optimisticOps]
                  .sort((a, b) => b.executedAt.localeCompare(a.executedAt))
                  .map((op) => (
                    <tr key={op.id}>
                      <td>{op.executedAt}</td>
                      <td>{op.kind === "buy" ? "Compra" : "Venta"}</td>
                      <td>{op.units}</td>
                      <td>
                        {op.pricePerUnit && privacyMode
                          ? maskMoneyString(op.pricePerUnit)
                          : op.pricePerUnit}
                      </td>
                      <td>
                        {op.feesMinor > 0
                          ? formatMoneyMinorPrivacy(
                              {
                                amountMinor: op.feesMinor,
                                currency: op.currency,
                              },
                              privacyMode,
                            )
                          : "—"}
                      </td>
                      <td className="rowActions">
                        <form action={deleteAction} onSubmit={onDelete(op.id)}>
                          <input name="currentUrl" type="hidden" value={currentUrl} />
                          <input name="operationId" type="hidden" value={op.id} />
                          <details className="confirmDelete">
                            <summary>Eliminar</summary>
                            <button type="submit">Confirmar</button>
                          </details>
                        </form>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

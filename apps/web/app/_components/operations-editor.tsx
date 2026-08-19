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

import type { FormErrorContext } from "@web/intake";
import { priceFreshnessLabel } from "@web/intake";
import { operationKindLabel } from "@web/operation-kind-copy";
import type {
  CaptureCurrency,
  InvestmentOperation,
  PriceFreshnessState,
} from "@worthline/domain";
import {
  BASE_CURRENCY,
  CAPTURE_CURRENCIES,
  compareInvestmentOperations,
  formatMoneyMinorPrivacy,
  isCaptureCurrency,
  maskMoneyString,
} from "@worthline/domain";
import { type FormEvent, useOptimistic, useRef, useState, useTransition } from "react";
import { readOperationFees, readOperationPrice } from "./operation-capture-reading";

import {
  applyOperationMutations,
  type OperationMutation,
  planOperationSubmit,
  submitOperationRecord,
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
  /**
   * The engine's currency warning for this ledger (#1401), when it has one: its
   * operations are not all in the currency the cost is labelled with, so the cost —
   * and every return derived from it — cannot be trusted. Rendered here because this
   * is where those operations are, and it is where they can be corrected.
   */
  currencyWarning?: string | null;
}

/**
 * What the "Último precio" cell reads: the price, masked under privacy mode, or
 * "Sin precio" when the caller has none to show — a holding whose fetch failed
 * keeps the row (its state chip is the news) but never renders a zero as if it
 * were the last price (#1330).
 */
function shownUnitPrice(unitPrice: string | undefined, privacyMode: boolean): string {
  if (!unitPrice) return "Sin precio";
  return privacyMode ? maskMoneyString(unitPrice) : unitPrice;
}

/**
 * The record form's submit button (#1394). It goes disabled while the action is
 * in flight, so the second of two clicks never reaches the server — the visible
 * half of the double-submit guard, whose server half is the idempotency key in
 * `planOperationSubmit`. Its own component so the pending markup is assertable
 * without a DOM: `PendingSubmit` cannot serve here because the JS path
 * `preventDefault`s and calls the action by hand, leaving `useFormStatus` idle.
 */
export function RecordOperationSubmit({ pending }: { pending: boolean }) {
  return (
    <button aria-busy={pending} disabled={pending} type="submit">
      {pending ? "Registrando…" : "Registrar operación"}
    </button>
  );
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
  defaultCurrency,
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
  /**
   * The currency the currency picker starts on (#1401): the one this holding's last
   * apunte was captured in, so a user buying the same dollar fund for the ninth time
   * types it once. Absent means EUR.
   */
  defaultCurrency?: CaptureCurrency | undefined;
  today: string;
}) {
  const operationValues = formError?.formId === "operation" ? formError.values : {};

  const [optimisticOps, addPending] = useOptimistic(
    operations,
    (current: readonly InvestmentOperation[], mutation: OperationMutation) =>
      applyOperationMutations(current, [mutation]),
  );
  // Two transitions, not one: the record button's pending state must describe
  // the RECORD action. Sharing a transition with delete had the button read
  // "Registrando…" while an operation was being deleted (#1394 review).
  const [isRecording, startRecording] = useTransition();
  const [isDeleting, startDeleting] = useTransition();
  const isPending = isRecording || isDeleting;
  // The idempotency key of the record submit currently in flight (#1394), null
  // between submits. Held in a ref, not state: it must be readable and writable
  // from inside the submit handler without waiting for a render, which is the
  // whole point — the two clicks that duplicated an operation happened before
  // `isPending` had a chance to flip.
  const inFlightSubmissionId = useRef<string | null>(null);
  // The currency the two money fields are labelled in (#1401). Client state because
  // the labels have to change AS the picker moves — the whole guard against typing
  // dollars under a «(EUR)» label — and it is a view toggle, so no page reload
  // (interaction-patterns §2). Without JS the select still posts its value and the
  // server converts identically; only the live relabelling is lost.
  // Narrowed, not trusted: `operationValues` comes back off a URL, so a hand-edited
  // `v_currency=JPY` would otherwise sit in the picker with no matching option (and the
  // server would refuse the submit for a reason the form never showed).
  const roundTripped = operationValues["currency"];
  const [captureCurrency, setCaptureCurrency] = useState<CaptureCurrency>(
    roundTripped !== undefined && isCaptureCurrency(roundTripped)
      ? roundTripped
      : (defaultCurrency ?? BASE_CURRENCY),
  );
  const convertsToEur = captureCurrency !== BASE_CURRENCY;

  // Record: build the optimistic row from the form, apply it, then run the action —
  // all in the transition so `useOptimistic` tracks it and `isRecording` holds
  // until the redirect lands. In demo we let the form fall back to its plain
  // `action=` post (no faked optimism, §10).
  const onRecord = readOnly
    ? undefined
    : (event: FormEvent<HTMLFormElement>) => {
        const formData = new FormData(event.currentTarget);
        const plan = planOperationSubmit({
          assetId,
          formData,
          inFlightSubmissionId: inFlightSubmissionId.current,
          newId: () => crypto.randomUUID(),
          today,
        });
        if (plan.kind === "native") {
          return; // let the native post + server validation surface the error
        }
        event.preventDefault();
        submitOperationRecord({
          addPending,
          formData,
          keyRef: inFlightSubmissionId,
          plan,
          recordAction,
          startTransition: startRecording,
        });
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

  return (
    // The anchor the danger zone's "registrar la venta" link lands on (#1365):
    // the correct exit for a holding with units is a recorded sell, and it lives
    // here, one collapsed block away from the delete button.
    <section aria-label="Operaciones de la inversión" id="operaciones">
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
            {/* A holding whose fetch failed has no price but DOES have a state to
                show: keep the row, say "Sin precio", never render a zero as if it
                were the last price (#1330). */}
            {context.unitPrice !== undefined || context.priceFreshness ? (
              <>
                <span className="contextLabel">Último precio</span>
                <span>
                  {shownUnitPrice(context.unitPrice, privacyMode)}{" "}
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

      {/* The engine says the cost cannot be trusted (#1401): said next to the
          operations it is about, in the same voice as a form refusal, because the
          figure above it is wrong until one of these rows is fixed. */}
      {context.currencyWarning ? (
        <p className="errorBand" role="alert">
          {context.currencyWarning}
        </p>
      ) : null}

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
          Unidades
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
          Divisa del apunte
          <select
            name="currency"
            onChange={(event) => {
              if (isCaptureCurrency(event.target.value)) {
                setCaptureCurrency(event.target.value);
              }
            }}
            value={captureCurrency}
          >
            {CAPTURE_CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </label>

        <label>
          Precio por unidad ({captureCurrency})
          <input
            aria-label={`Precio por unidad en ${captureCurrency}`}
            aria-required="true"
            defaultValue={operationValues["pricePerUnit"]}
            inputMode="decimal"
            name="pricePerUnit"
            placeholder="100,00"
          />
        </label>

        <label>
          Comisiones ({captureCurrency}) <small>(opcional)</small>
          <input
            aria-label={`Comisiones en ${captureCurrency}`}
            defaultValue={operationValues["fees"] ?? "0"}
            inputMode="decimal"
            name="fees"
            placeholder="0"
          />
        </label>

        {/* Said BEFORE the submit, not after: the conversion is dated to the
            execution day, which is the fact that decides whether the cost basis is
            right (#1401). */}
        {convertsToEur ? (
          <p className="opCaptureHint">
            Lo guardaremos en euros con el tipo del BCE del día de la operación.
          </p>
        ) : null}

        <RecordOperationSubmit pending={isRecording} />
      </form>

      {optimisticOps.length > 0 ? (
        <details suppressHydrationWarning className="recentOpsPanel" open>
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
                  .sort((a, b) => compareInvestmentOperations(b, a))
                  .map((op) => {
                    const price = readOperationPrice(op, privacyMode);
                    const fees = readOperationFees(op, privacyMode);

                    return (
                      <tr key={op.id}>
                        <td>{op.executedAt}</td>
                        <td>{operationKindLabel(op.kind)}</td>
                        <td>{op.units}</td>
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
        </details>
      ) : null}
    </section>
  );
}

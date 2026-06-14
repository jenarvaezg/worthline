/**
 * Operations editor — the `derived` valuation surface (#152, ADR 0006/0014).
 *
 * Records buy/sell operations, lists them (date desc) with a two-step delete,
 * and shows the derived units / value context. An investment's value is never
 * edited by hand (ADR 0006); the only way to move units is an operation. This is
 * the single component the surface lives in, so both the unified holding detail
 * (`/patrimonio/[id]/editar`) and the transitional `/inversiones/[id]/operacion`
 * render the same editor — they pass already-bound server actions and the data.
 *
 * Server-rendered, zero client JS (ADR 0009): forms POST, the list uses native
 * <details>, the page re-renders from the store after each action's redirect.
 */

import { formatMoneyMinor } from "@worthline/domain";
import type { InvestmentOperation, PriceFreshnessState } from "@worthline/domain";

import { priceFreshnessLabel } from "../intake";
import type { FormErrorContext } from "../intake";

export interface OperationsEditorContext {
  /** The current units held, as derived from the operations (PositionView). */
  currentUnits?: string;
  /** The latest cached unit price (string), when one is known. */
  unitPrice?: string;
  /** Freshness of the cached price, for the small status chip. */
  priceFreshness?: PriceFreshnessState | null;
  /** The derived market value (units × price), when priced. */
  marketValue?: { amountMinor: number; currency: string } | null;
}

/**
 * Render the operations editor for a `derived` holding. `currentUrl` is the page
 * the bound actions return to (so it works identically from either route); the
 * record/delete actions are already bound to the asset id by the caller.
 */
export default function OperationsEditor({
  assetName,
  context,
  currentUrl,
  formError,
  operations,
  recordAction,
  deleteAction,
  today,
}: {
  assetName: string;
  context: OperationsEditorContext;
  currentUrl: string;
  formError: FormErrorContext | null;
  operations: readonly InvestmentOperation[];
  recordAction: (formData: FormData) => void | Promise<void>;
  deleteAction: (formData: FormData) => void | Promise<void>;
  today: string;
}) {
  const operationValues = formError?.formId === "operation" ? formError.values : {};

  return (
    <section className="inversionesSubpage" aria-label="Operaciones de la inversión">
      <h3>Operaciones</h3>

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
                  {context.unitPrice}{" "}
                  <small className={`priceStatus ${context.priceFreshness ?? "unknown"}`}>
                    {priceFreshnessLabel(context.priceFreshness ?? null)}
                  </small>
                </span>
              </>
            ) : null}
            {context.marketValue ? (
              <>
                <span className="contextLabel">Valor actual</span>
                <span>{formatMoneyMinor(context.marketValue)}</span>
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

      {operations.length > 0 ? (
        <details className="recentOpsPanel" open>
          <summary>Todas las operaciones ({operations.length})</summary>
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
                {[...operations]
                  .sort((a, b) => b.executedAt.localeCompare(a.executedAt))
                  .map((op) => (
                    <tr key={op.id}>
                      <td>{op.executedAt}</td>
                      <td>{op.kind === "buy" ? "Compra" : "Venta"}</td>
                      <td>{op.units}</td>
                      <td>{op.pricePerUnit}</td>
                      <td>
                        {op.feesMinor > 0
                          ? formatMoneyMinor({
                              amountMinor: op.feesMinor,
                              currency: op.currency,
                            })
                          : "—"}
                      </td>
                      <td className="rowActions">
                        <form action={deleteAction}>
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

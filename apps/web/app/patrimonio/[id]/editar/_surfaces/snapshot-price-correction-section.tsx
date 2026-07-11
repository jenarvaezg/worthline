"use client";

/**
 * Single-date snapshot unit-price correction (#926).
 *
 * Preview-then-confirm: the user picks a date and unit price, previews the
 * create/update counts without writing, then confirms to freeze that price on
 * the chosen daily snapshot across scopes.
 */

import type { SnapshotPriceCorrectionPreviewState } from "@web/inversiones/actions";
import { formatMoneyMinor } from "@worthline/domain";
import { startTransition, useActionState } from "react";

const IDLE: SnapshotPriceCorrectionPreviewState = { status: "idle" };

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** es-ES short date for a YYYY-MM-DD key. */
function formatDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-");
  return `${day}/${month}/${year}`;
}

export function SnapshotPriceCorrectionSection({
  previewAction,
  confirmAction,
  currentUrl,
  defaultUnitPrice,
  today,
}: {
  previewAction: (
    prev: SnapshotPriceCorrectionPreviewState,
    formData: FormData,
  ) => Promise<SnapshotPriceCorrectionPreviewState>;
  confirmAction: (formData: FormData) => Promise<void>;
  currentUrl: string;
  /** Cached live price — prefills the unit-price field when present. */
  defaultUnitPrice?: string;
  today: string;
}) {
  const [preview, dispatchPreview, isPreviewPending] = useActionState(
    previewAction,
    IDLE,
  );

  const shown = isPreviewPending ? IDLE : preview;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const isPreview =
      submitter instanceof HTMLButtonElement && submitter.value === "preview";

    if (!isPreview) {
      return;
    }

    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatchPreview(formData));
  }

  function fillDefaultPrice(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!defaultUnitPrice) return;
    const form = event.currentTarget.form;
    if (!form) return;
    const input = form.elements.namedItem("unitPrice");
    if (input instanceof HTMLInputElement) {
      input.value = defaultUnitPrice;
    }
  }

  return (
    <section aria-label="Corregir precio de un día">
      <h3>Corregir precio de un día</h3>
      <p className="contextLabel">
        Corrige el precio por unidad congelado en un snapshot concreto (por ejemplo, un
        día valorado a coste). Solo afecta a esa fecha — no reescribe el histórico mensual
        completo.
      </p>

      <form className="stackForm inversionesForm" onSubmit={handleSubmit}>
        <input name="currentUrl" type="hidden" value={currentUrl} />

        <label>
          Fecha del snapshot
          <input defaultValue={today} max={today} name="dateKey" required type="date" />
        </label>

        <label>
          Precio por unidad (EUR)
          <input
            defaultValue={defaultUnitPrice ?? ""}
            inputMode="decimal"
            name="unitPrice"
            placeholder="12,50"
            required
            step="any"
            type="text"
          />
        </label>

        {defaultUnitPrice ? (
          <button onClick={fillDefaultPrice} type="button">
            Usar precio actual del proveedor
          </button>
        ) : null}

        <button disabled={isPreviewPending} name="intent" type="submit" value="preview">
          Ver cambios
        </button>

        {shown.status === "error" ? (
          <div className="formError" role="alert">
            <p>No se puede corregir el snapshot:</p>
            <p>{shown.message}</p>
          </div>
        ) : null}

        {shown.status === "not_eligible" ? (
          <p className="contextLabel">
            Esta inversión no admite corrección (sin operaciones registradas).
          </p>
        ) : null}

        {shown.status === "summary" ? (
          <div className="importPreview">
            <p>
              Fecha: <strong>{formatDateKey(shown.dateKey)}</strong>
            </p>
            <p>
              Precio: <strong>{shown.unitPrice} EUR</strong> × {shown.units} uds ={" "}
              <strong>
                {formatMoneyMinor({ amountMinor: shown.valueMinor, currency: "EUR" })}
              </strong>
            </p>

            {shown.create + shown.update === 0 ? (
              <p className="contextLabel">
                No hay snapshots que actualizar para esa fecha.
              </p>
            ) : (
              <>
                <p>Esta corrección aplicará:</p>
                <ul className="importPreviewSummary">
                  <li>{count(shown.create, "snapshot nuevo", "snapshots nuevos")}</li>
                  <li>
                    {count(
                      shown.update,
                      "snapshot actualizado",
                      "snapshots actualizados",
                    )}
                  </li>
                </ul>
              </>
            )}

            {shown.create + shown.update > 0 ? (
              <>
                <input name="dateKey" type="hidden" value={shown.dateKey} />
                <input name="unitPrice" type="hidden" value={shown.unitPrice} />
                <button formAction={confirmAction} type="submit">
                  Confirmar corrección
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </form>
    </section>
  );
}

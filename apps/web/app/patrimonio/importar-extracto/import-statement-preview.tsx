"use client";

import { startTransition, useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import type { FundPreviewRow, ImportStatementPreviewState } from "./actions";
import {
  pluralize,
  summarizeImportSelection,
  type FundSelectionState,
} from "./import-statement-summary";

/**
 * Multi-fund statement preview → confirm island (PRD #669 S2, #673, ADR 0055).
 *
 * Mirrors `StatementUploadSection` (#176): the preview submit bypasses React's
 * form-action path (onSubmit + preventDefault + manual dispatch) because React
 * 19 resets uncontrolled fields — including the file input — after a form
 * action runs, which would drop the file before confirm; the confirm button
 * goes through `formAction`, where the post-action reset is harmless because a
 * successful confirm redirects away.
 *
 * The only client state is per-fund include/symbol-empty flags — the confirm
 * summary (fondos, operaciones, importe, aviso pendiente) recomputes from that
 * state through the pure `summarizeImportSelection` module on every toggle, no
 * server round-trip (docs/interaction-patterns.md §7).
 */

const IDLE: ImportStatementPreviewState = { status: "idle" };

interface FundSelectionFlags {
  included: boolean;
  replaceOpening: boolean;
  symbolEmpty: boolean;
}

function bucketLabel(bucket: "matched" | "new"): string {
  return bucket === "matched" ? "Encaja" : "Nuevo";
}

function fundDisplayName(fund: FundPreviewRow): string {
  if (fund.bucket === "matched") return fund.existingName;
  return fund.suggestedName || fund.isin;
}

function formatMoney(amountMinor: number): string {
  return new Intl.NumberFormat("es-ES", {
    currency: "EUR",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
}

function formatUnits(units: string): string {
  const value = Number(units);
  if (!Number.isFinite(value)) return units;
  return new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: 6,
  }).format(value);
}

function positionFlagLabel(
  flag: FundPreviewRow["positionImpact"]["flags"][number],
): string {
  switch (flag) {
    case "nearly_doubles":
      return "posible duplicado";
    case "oversell":
      return "venta excede posición";
    case "near_zero":
      return "queda a cero";
  }
}

function defaultFlagsFor(fund: FundPreviewRow): FundSelectionFlags {
  if (fund.bucket === "matched") {
    return {
      included: true,
      replaceOpening: fund.toDeleteCount > 0,
      symbolEmpty: false,
    };
  }
  return {
    included: fund.suggestedSymbol !== "",
    replaceOpening: false,
    symbolEmpty: fund.suggestedSymbol === "",
  };
}

function ConfirmSubmit({
  confirmAction,
  disabled,
  label,
}: {
  confirmAction: (formData: FormData) => Promise<void>;
  disabled: boolean;
  label: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      aria-busy={pending}
      disabled={disabled || pending}
      formAction={confirmAction}
      type="submit"
    >
      {pending ? "Aplicando…" : label}
    </button>
  );
}

export function ImportStatementPreview({
  previewAction,
  confirmAction,
  currentUrl,
  readOnly,
}: {
  previewAction: (
    prev: ImportStatementPreviewState,
    formData: FormData,
  ) => Promise<ImportStatementPreviewState>;
  confirmAction: (formData: FormData) => Promise<void>;
  currentUrl: string;
  readOnly: boolean;
}) {
  const [preview, dispatchPreview, isPreviewPending] = useActionState(
    previewAction,
    IDLE,
  );
  const [fileChangedSincePreview, setFileChangedSincePreview] = useState(false);
  const [selection, setSelection] = useState<Record<string, FundSelectionFlags>>({});
  const [seededFunds, setSeededFunds] = useState<FundPreviewRow[] | null>(null);

  const shown = fileChangedSincePreview || isPreviewPending ? IDLE : preview;
  const funds = shown.status === "ready" ? shown.funds : [];

  if (shown.status === "ready" && shown.funds !== seededFunds) {
    setSeededFunds(shown.funds);
    setSelection(
      Object.fromEntries(shown.funds.map((fund) => [fund.isin, defaultFlagsFor(fund)])),
    );
  }

  const summaryInput: FundSelectionState[] = funds.map((fund) => ({
    amountMinor: fund.amountMinor,
    bucket: fund.bucket,
    executedCount: fund.executedCount,
    included: selection[fund.isin]?.included ?? false,
    isin: fund.isin,
    skippedCount: fund.skippedCount,
    symbolEmpty: selection[fund.isin]?.symbolEmpty ?? false,
  }));
  const summary = summarizeImportSelection(summaryInput);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const isPreview =
      submitter instanceof HTMLButtonElement && submitter.value === "preview";

    if (!isPreview) return;

    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setFileChangedSincePreview(false);
    startTransition(() => dispatchPreview(formData));
  }

  function toggleIncluded(isin: string) {
    setSelection((current) => ({
      ...current,
      [isin]: {
        ...(current[isin] ?? defaultFlagsForIsin()),
        included: !current[isin]?.included,
      },
    }));
  }

  function defaultFlagsForIsin(): FundSelectionFlags {
    return { included: false, replaceOpening: false, symbolEmpty: false };
  }

  function setSymbolEmpty(isin: string, symbolEmpty: boolean) {
    setSelection((current) => ({
      ...current,
      [isin]: { ...(current[isin] ?? defaultFlagsForIsin()), symbolEmpty },
    }));
  }

  function setReplaceOpening(isin: string, replaceOpening: boolean) {
    setSelection((current) => ({
      ...current,
      [isin]: { ...(current[isin] ?? defaultFlagsForIsin()), replaceOpening },
    }));
  }

  return (
    <section aria-label="Importar extracto">
      <p className="infoNote">
        Sube la plantilla de Worthline (CSV o Excel): se agrupa por identificador y se
        reparte por toda la cartera — encaja con lo que ya tienes, ofrece crear lo que no,
        y puedes dejar fuera lo que no quieras seguir.
      </p>

      <form className="stackForm inversionesForm" onSubmit={handleSubmit}>
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="broker" type="hidden" value="plantilla" />

        <label>
          Archivo de operaciones (.csv o .xlsx)
          <input
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={readOnly}
            name="file"
            onChange={() => setFileChangedSincePreview(true)}
            required
            type="file"
          />
        </label>

        <p className="infoNote">
          ¿Tu bróker no exporta, o exporta mal?{" "}
          <a download href="/plantilla-operaciones.csv">
            Descarga la plantilla
          </a>{" "}
          y rellénala: una fila por operación (Compra o Venta, importes siempre en
          positivo, un traspaso son dos filas), mezclando fondos, ETFs, acciones, planes y
          cripto en el mismo archivo. Vale mantenerla en Excel y subir el .xlsx
          directamente; al re-subirla solo se aplican los cambios.
        </p>

        <button
          disabled={readOnly || isPreviewPending}
          name="intent"
          type="submit"
          value="preview"
        >
          Ver preview
        </button>

        {shown.status === "error" ? (
          <div className="formError" role="alert">
            <p>No se puede leer este archivo:</p>
            <p>{shown.message}</p>
          </div>
        ) : null}

        {shown.status === "ready" ? (
          <div className="importPreview">
            <div className="tableScroll">
              <table>
                <caption>
                  Una fila por identificador. El detalle de fusión se abre dentro de la
                  fila.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Incluir</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Identificador</th>
                    <th scope="col">Inversión</th>
                    <th scope="col">Órdenes</th>
                    <th scope="col">Importe</th>
                    <th scope="col">Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {funds.map((fund) => {
                    const flags = selection[fund.isin] ?? defaultFlagsFor(fund);
                    const displayName = fundDisplayName(fund);
                    const unresolved =
                      fund.bucket === "new" && fund.lookup.status !== "found";
                    const positionImpact =
                      fund.bucket === "matched" &&
                      !flags.replaceOpening &&
                      fund.openingKeptPositionImpact
                        ? fund.openingKeptPositionImpact
                        : fund.positionImpact;

                    return (
                      <tr key={fund.isin}>
                        <td>
                          <label className="includeToggle">
                            <input
                              aria-label={`Incluir ${displayName}`}
                              checked={flags.included}
                              disabled={readOnly}
                              name={`include_${fund.isin}`}
                              onChange={() => toggleIncluded(fund.isin)}
                              type="checkbox"
                            />
                            <span aria-hidden="true">{flags.included ? "Sí" : "No"}</span>
                          </label>
                        </td>
                        <td>
                          <span
                            className={`statePill ${fund.bucket === "matched" ? "matched" : "new"}`}
                          >
                            {bucketLabel(fund.bucket)}
                          </span>
                        </td>
                        <th scope="row">
                          <code>{fund.isin}</code>
                        </th>
                        <td>
                          {fund.bucket === "matched" ? (
                            <strong>{fund.existingName}</strong>
                          ) : (
                            <div className="stackForm">
                              <label>
                                Nombre
                                <input
                                  defaultValue={fund.suggestedName}
                                  disabled={readOnly || !flags.included}
                                  name={`name_${fund.isin}`}
                                  placeholder={fund.isin}
                                  type="text"
                                />
                              </label>
                              <label>
                                Símbolo
                                <input
                                  defaultValue={fund.suggestedSymbol}
                                  disabled={readOnly || !flags.included}
                                  name={`symbol_${fund.isin}`}
                                  onChange={(e) =>
                                    setSymbolEmpty(
                                      fund.isin,
                                      e.currentTarget.value.trim() === "",
                                    )
                                  }
                                  placeholder="p. ej. IWDA.AS"
                                  type="text"
                                />
                              </label>
                              {unresolved && fund.suggestedSymbol === "" ? (
                                <p className="infoNote">
                                  {fund.lookup.status === "error"
                                    ? "La búsqueda de símbolo falló — edítalo a mano."
                                    : "Sin coincidencia para este identificador — edítalo a mano."}{" "}
                                  Sin símbolo, el activo nacerá con el aviso pendiente
                                  MISSING_PROVIDER_SYMBOL.
                                </p>
                              ) : null}
                            </div>
                          )}
                        </td>
                        <td>
                          <strong>
                            {pluralize(fund.executedCount, "operación", "operaciones")}
                          </strong>
                          {fund.skippedCount > 0 ? (
                            <span className="contextLabel">
                              {" "}
                              · {pluralize(fund.skippedCount, "saltada", "saltadas")}
                            </span>
                          ) : null}
                        </td>
                        <td>{formatMoney(fund.amountMinor)}</td>
                        <td>
                          <div className="positionImpact">
                            <p className="positionImpactLine">
                              {formatUnits(positionImpact.beforeUnits)} uds (
                              {formatMoney(positionImpact.beforeValueMinor)}) →{" "}
                              {formatUnits(positionImpact.afterUnits)} uds (
                              {formatMoney(positionImpact.afterValueMinor)})
                            </p>
                            {positionImpact.flags.length > 0 ? (
                              <ul
                                aria-label="Avisos de posición"
                                className="positionFlags"
                              >
                                {positionImpact.flags.map((flag) => (
                                  <li className="positionFlag" key={flag}>
                                    {positionFlagLabel(flag)}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {fund.bucket === "matched" ? (
                              <details>
                                <summary>Ver fusión</summary>
                                <p>
                                  {pluralize(
                                    fund.toCreateCount,
                                    "operación nueva",
                                    "operaciones nuevas",
                                  )}
                                  {" · "}
                                  {pluralize(
                                    fund.toOverwriteCount,
                                    "sobrescrita",
                                    "sobrescritas",
                                  )}
                                  {fund.toDeleteCount > 0
                                    ? ` · ${pluralize(
                                        fund.toDeleteCount,
                                        "apertura sustituida",
                                        "aperturas sustituidas",
                                      )}`
                                    : ""}
                                </p>
                                {fund.toDeleteCount > 0 ? (
                                  <label className="directionOptIn">
                                    <input
                                      name={`replaceOpeningSeen_${fund.isin}`}
                                      type="hidden"
                                      value="on"
                                    />
                                    <input
                                      checked={flags.replaceOpening}
                                      disabled={readOnly || !flags.included}
                                      name={`replaceOpening_${fund.isin}`}
                                      onChange={(event) =>
                                        setReplaceOpening(
                                          fund.isin,
                                          event.currentTarget.checked,
                                        )
                                      }
                                      type="checkbox"
                                    />
                                    Sustituir la apertura por el historial importado.
                                  </label>
                                ) : null}
                              </details>
                            ) : (
                              <span className="contextLabel">Activo nuevo</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div aria-live="polite" className="importPreviewSummary">
              <p>
                {pluralize(summary.fundCount, "activo incluido", "activos incluidos")} ·{" "}
                {pluralize(summary.executedRows, "operación", "operaciones")} ·{" "}
                {formatMoney(summary.amountMinor)}
              </p>
              <p className="contextLabel">
                {pluralize(summary.matchedCount, "activo encaja", "activos encajan")} ·{" "}
                {pluralize(summary.newCount, "activo nuevo", "activos nuevos")} ·{" "}
                {pluralize(summary.excludedCount, "activo fuera", "activos fuera")}
              </p>
              {summary.unresolvedSymbolCount > 0 ? (
                <p className="warningBand" role="alert">
                  {pluralize(
                    summary.unresolvedSymbolCount,
                    "activo incluido sin símbolo",
                    "activos incluidos sin símbolo",
                  )}
                  : {summary.unresolvedSymbolCount === 1 ? "nacerá" : "nacerán"} con el
                  aviso pendiente MISSING_PROVIDER_SYMBOL.
                </p>
              ) : null}
              <p className="contextLabel">
                Confirmar aplica los activos incluidos todo o nada: si algo falla, no se
                escribe nada.
              </p>
            </div>

            <ConfirmSubmit
              confirmAction={confirmAction}
              disabled={readOnly || summary.fundCount === 0}
              label={`Confirmar ${pluralize(summary.fundCount, "activo", "activos")}`}
            />
          </div>
        ) : null}
      </form>
    </section>
  );
}

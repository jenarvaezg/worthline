"use client";

import { formatUnits } from "@worthline/domain";
import { startTransition, useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import type {
  FundMatchChoice,
  FundPreviewRow,
  ImportStatementPreviewState,
} from "./actions";
import {
  chooseFundHolding,
  defaultFundSelection,
  type FundSelectionFlags,
  type FundSelectionState,
  isFundChoicePending,
  pluralize,
  summarizeImportSelection,
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
 * The only client state is per-fund include/symbol-empty flags plus, for an
 * identifier several holdings claim, which one the user named (#1366) — the
 * confirm summary (fondos, operaciones, importe, avisos pendientes) recomputes
 * from that state through the pure `summarizeImportSelection` module on every
 * toggle, no server round-trip (docs/interaction-patterns.md §7). Switching the
 * chosen holding likewise re-renders that row's merge counts and position impact
 * from the candidates the server already sent, never a second request.
 */

const IDLE: ImportStatementPreviewState = { status: "idle" };

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

/** Project a preview row onto the pure module's opening state. */
function defaultFlagsFor(fund: FundPreviewRow): FundSelectionFlags {
  return defaultFundSelection(
    fund.bucket === "matched"
      ? {
          ambiguous: fund.ambiguous,
          assetId: fund.assetId,
          bucket: "matched",
          replacesOpening: fund.toDeleteCount > 0,
        }
      : { bucket: "new", suggestedSymbol: fund.suggestedSymbol },
  );
}

/** The claimant whose figures the row currently shows — the chosen one, or the default. */
function chosenChoice(
  fund: FundPreviewRow,
  flags: FundSelectionFlags,
): FundMatchChoice | null {
  if (fund.bucket !== "matched") return null;
  return (
    fund.choices.find((choice) => choice.assetId === flags.assetId) ??
    fund.choices[0] ??
    null
  );
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
    choicePending: isFundChoicePending(fund, {
      assetId: selection[fund.isin]?.assetId ?? "",
    }),
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
    return { assetId: "", included: false, replaceOpening: false, symbolEmpty: false };
  }

  function chooseHolding(fund: FundPreviewRow, assetId: string) {
    if (fund.bucket !== "matched") return;
    const choice = fund.choices.find((entry) => entry.assetId === assetId);
    setSelection((current) => ({
      ...current,
      [fund.isin]: chooseFundHolding(current[fund.isin] ?? defaultFlagsForIsin(), {
        assetId,
        replacesOpening: (choice?.toDeleteCount ?? 0) > 0,
      }),
    }));
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
        Sube la plantilla de Worthline o el extracto de transacciones de tu bróker (CSV o
        Excel, con columna ISIN): se agrupa por identificador y se reparte por toda la
        cartera — encaja con lo que ya tienes, ofrece crear lo que no, y puedes dejar
        fuera lo que no quieras seguir.
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
            {/* What the reading could not settle (#1488) — an assumed direction, an
                assumed currency, a row it skipped. Above the table, because it is what
                decides whether the figures below are worth confirming, and in the canon's
                AVISO register rather than as an `infoNote`: `--gold` is the token for a
                warning and `--muted` is for an aside (docs/design-system.md §1). ONE band
                holds every line — `.warningBand` is a grid for exactly that — so five
                doubts read as one thing to check, not as five alarms. */}
            {shown.warnings.length > 0 ? (
              <div className="warningBand">
                {shown.warnings.map((warning) => (
                  <span key={warning}>{warning}</span>
                ))}
              </div>
            ) : null}

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
                    const choicePending = isFundChoicePending(fund, flags);
                    // While the choice is pending there is no holding to speak
                    // for: no name, no figures — the only ones on hand are the
                    // first candidate's (#1366).
                    const choice = choicePending ? null : chosenChoice(fund, flags);
                    const displayName = choicePending
                      ? fund.isin
                      : (choice?.existingName ?? fundDisplayName(fund));
                    const unresolved =
                      fund.bucket === "new" && fund.lookup.status !== "found";
                    const positionImpact =
                      choice && !flags.replaceOpening && choice.openingKeptPositionImpact
                        ? choice.openingKeptPositionImpact
                        : (choice?.positionImpact ?? fund.positionImpact);

                    return (
                      <tr key={fund.isin}>
                        <td>
                          <label className="includeToggle">
                            <input
                              aria-label={`Incluir ${displayName}`}
                              checked={flags.included}
                              disabled={readOnly || choicePending}
                              name={`include_${fund.isin}`}
                              onChange={() => toggleIncluded(fund.isin)}
                              type="checkbox"
                            />
                            <span aria-hidden="true">{flags.included ? "Sí" : "No"}</span>
                          </label>
                        </td>
                        <td>
                          <span
                            className={`statePill ${
                              fund.bucket === "matched"
                                ? fund.ambiguous
                                  ? "ambiguous"
                                  : "matched"
                                : "new"
                            }`}
                          >
                            {fund.bucket === "matched" && fund.ambiguous
                              ? "Elige"
                              : bucketLabel(fund.bucket)}
                          </span>
                        </td>
                        <th scope="row">
                          <code>{fund.isin}</code>
                        </th>
                        <td>
                          {fund.bucket === "matched" ? (
                            fund.ambiguous ? (
                              <div className="stackForm">
                                <label>
                                  {`¿Cuál de tus inversiones es ${fund.isin}?`}
                                  <select
                                    disabled={readOnly}
                                    name={`assetId_${fund.isin}`}
                                    onChange={(event) =>
                                      chooseHolding(fund, event.currentTarget.value)
                                    }
                                    value={flags.assetId}
                                  >
                                    <option value="">— elige una —</option>
                                    {fund.choices.map((option) => (
                                      <option key={option.assetId} value={option.assetId}>
                                        {option.existingName}
                                        {option.closed ? " (posición cerrada)" : ""}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <p className="infoNote">
                                  {pluralize(
                                    fund.choices.length,
                                    "inversión tuya lleva",
                                    "inversiones tuyas llevan",
                                  )}{" "}
                                  este identificador — el mismo fondo en dos brókers. El
                                  archivo no dice cuál, y cargarlo puede sobrescribir
                                  operaciones: elígela tú.
                                </p>
                              </div>
                            ) : (
                              <strong>{fund.existingName}</strong>
                            )
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
                          {choicePending ? (
                            <p className="contextLabel">
                              Elige la inversión para ver qué le pasa a la posición.
                            </p>
                          ) : (
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
                              {choice ? (
                                <details suppressHydrationWarning>
                                  <summary>Ver fusión</summary>
                                  <p>
                                    {pluralize(
                                      choice.toCreateCount,
                                      "operación nueva",
                                      "operaciones nuevas",
                                    )}
                                    {" · "}
                                    {pluralize(
                                      choice.toOverwriteCount,
                                      "sobrescrita",
                                      "sobrescritas",
                                    )}
                                    {choice.toDeleteCount > 0
                                      ? ` · ${pluralize(
                                          choice.toDeleteCount,
                                          "apertura sustituida",
                                          "aperturas sustituidas",
                                        )}`
                                      : ""}
                                  </p>
                                  {choice.toDeleteCount > 0 ? (
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
                          )}
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
              {summary.pendingChoiceCount > 0 ? (
                <p className="warningBand" role="alert">
                  {pluralize(
                    summary.pendingChoiceCount,
                    "identificador",
                    "identificadores",
                  )}{" "}
                  {summary.pendingChoiceCount === 1 ? "lo llevan" : "los llevan"} varias
                  inversiones tuyas:{" "}
                  {summary.pendingChoiceCount === 1 ? "se queda" : "se quedan"} fuera
                  hasta que elijas cuál es.
                </p>
              ) : null}
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

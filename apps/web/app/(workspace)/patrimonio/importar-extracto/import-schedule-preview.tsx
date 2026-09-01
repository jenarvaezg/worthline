"use client";

import { startTransition, useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import type { ImportScheduleState, ScheduleImportTarget } from "./schedule-actions";
import {
  pluralize,
  rebaselineNoticeSentence,
  scheduleVerdict,
  scheduleVerificationSentence,
  scheduleWriteSentence,
  scheduleWritesSomething,
} from "./schedule-import-summary";

/**
 * Upload → preview → confirm island for a bank's cuadro de amortización (#1406).
 *
 * Mirrors `ImportStatementPreview` (#673) where the mechanics are the same — the
 * preview submit bypasses React's form-action path so the file input survives
 * into confirm — and differs where the DOCUMENT differs: what a cuadro yields is
 * not matched/new/ignored funds but the model inputs of a debt, checked against
 * the balances the same document prints.
 *
 * The verdict never disables the button on its own (ADR 0070 §4): it says what it
 * measured and what confirming will do. Only «nothing left to write» disables it.
 */

const IDLE: ImportScheduleState = { status: "idle" };

function formatMoney(amountMinor: number): string {
  return new Intl.NumberFormat("es-ES", {
    currency: "EUR",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
}

function formatRate(annualInterestRate: string): string {
  return `${new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: 3,
    minimumFractionDigits: 2,
  }).format(Number(annualInterestRate) * 100)} %`;
}

function statusLabel(status: "new" | "duplicate" | "outside-term"): string {
  switch (status) {
    case "new":
      return "Se carga";
    case "duplicate":
      return "Ya la tienes";
    case "outside-term":
      return "Fuera de plazo";
  }
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

export function ImportSchedulePreview({
  previewAction,
  confirmAction,
  currentUrl,
  readOnly,
  targets,
}: {
  previewAction: (
    prev: ImportScheduleState,
    formData: FormData,
  ) => Promise<ImportScheduleState>;
  confirmAction: (formData: FormData) => Promise<void>;
  currentUrl: string;
  readOnly: boolean;
  targets: readonly ScheduleImportTarget[];
}) {
  const [preview, dispatchPreview, isPreviewPending] = useActionState(
    previewAction,
    IDLE,
  );
  const [fileChangedSincePreview, setFileChangedSincePreview] = useState(false);

  const shown = fileChangedSincePreview || isPreviewPending ? IDLE : preview;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (!(submitter instanceof HTMLButtonElement && submitter.value === "preview")) {
      return;
    }
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setFileChangedSincePreview(false);
    startTransition(() => dispatchPreview(formData));
  }

  if (targets.length === 0) {
    return (
      <section aria-label="Importar cuadro de amortización">
        <p className="infoNote">
          Todavía no tienes ninguna deuda con cuadro de condiciones. Dale de alta capital,
          plazo, tipo y fechas en <a href="/patrimonio/anadir">/patrimonio/anadir</a>,
          cajón «Deuda», y vuelve aquí a subir el cuadro del banco: este lector escribe
          las revisiones y las amortizaciones sobre un plan que ya existe, no lo crea.
        </p>
      </section>
    );
  }

  const plan = shown.status === "ready" ? shown.preview.value : null;

  return (
    <section aria-label="Importar cuadro de amortización">
      <p className="infoNote">
        Sube el cuadro de amortización tal cual te lo da el banco (Excel o CSV). Leo de él
        las revisiones de tipo y las amortizaciones anticipadas, y antes de guardar nada
        compruebo que la curva que sale reproduce los saldos que el propio cuadro declara.
      </p>

      <form className="stackForm inversionesForm" onSubmit={handleSubmit}>
        <input name="currentUrl" type="hidden" value={currentUrl} />

        <label>
          ¿De qué deuda es este cuadro?
          <select
            defaultValue={targets[0]?.liabilityId}
            disabled={readOnly}
            name="liabilityId"
            required
          >
            {targets.map((target) => (
              <option key={target.liabilityId} value={target.liabilityId}>
                {target.name}
                {target.revisionCount > 0
                  ? ` — ${pluralize(target.revisionCount, "revisión ya cargada", "revisiones ya cargadas")}`
                  : " — sin revisiones todavía"}
              </option>
            ))}
          </select>
        </label>

        <label>
          Cuadro de amortización (.xlsx o .csv)
          <input
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={readOnly}
            name="file"
            onChange={() => setFileChangedSincePreview(true)}
            required
            type="file"
          />
        </label>

        <label>
          Qué hizo el banco con cada amortización anticipada
          <select
            defaultValue="reduce-payment"
            disabled={readOnly}
            name="earlyRepaymentMode"
          >
            <option value="reduce-payment">Bajar la cuota (mismo plazo)</option>
            <option value="reduce-term">Acortar el plazo (misma cuota)</option>
          </select>
        </label>

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
            <p>No se puede leer este cuadro:</p>
            <p>{shown.message}</p>
          </div>
        ) : null}

        {shown.status === "ready" && plan ? (
          <div className="importPreview">
            {shown.preview.sheetName ? (
              <p className="infoNote">
                Leído de la hoja «{shown.preview.sheetName}» para{" "}
                {shown.preview.liabilityName}.
              </p>
            ) : null}

            {plan.warnings.map((warning) => (
              <p className="infoNote" key={warning}>
                {warning}
              </p>
            ))}

            <div className="tableScroll">
              <table>
                <caption>Lo que trae el cuadro</caption>
                <thead>
                  <tr>
                    <th scope="col">Fecha</th>
                    <th scope="col">Qué es</th>
                    <th scope="col">Valor</th>
                    <th scope="col">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.revisions.map((revision) => (
                    <tr key={`rev_${revision.revisionDate}`}>
                      <th scope="row">{revision.revisionDate}</th>
                      <td>Revisión de tipo</td>
                      <td>
                        {formatRate(revision.newAnnualInterestRate)}
                        {revision.existingAnnualInterestRate ? (
                          <span className="contextLabel">
                            {" "}
                            · tienes guardado{" "}
                            {formatRate(revision.existingAnnualInterestRate)}
                          </span>
                        ) : null}
                      </td>
                      <td>{statusLabel(revision.status)}</td>
                    </tr>
                  ))}
                  {plan.earlyRepayments.map((repayment) => (
                    <tr key={`amo_${repayment.repaymentDate}`}>
                      <th scope="row">{repayment.repaymentDate}</th>
                      <td>Amortización anticipada</td>
                      <td>{formatMoney(repayment.amountMinor)}</td>
                      <td>{statusLabel(repayment.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {plan.checkpoints.length > 0 ? (
              <details suppressHydrationWarning>
                <summary>
                  Ver la comprobación contra los saldos del cuadro (
                  {plan.checkpoints.length})
                </summary>
                <div className="tableScroll">
                  <table>
                    <caption>
                      Cada saldo que el cuadro declara, frente a lo que diría worthline
                      con este cuadro cargado.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Fecha</th>
                        <th scope="col">Dice el cuadro</th>
                        <th scope="col">Diría worthline</th>
                        <th scope="col">Diferencia</th>
                        <th scope="col">Manda</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.checkpoints.map((checkpoint) => (
                        <tr key={checkpoint.dateKey}>
                          <th scope="row">{checkpoint.dateKey}</th>
                          <td>{formatMoney(checkpoint.declaredMinor)}</td>
                          <td>{formatMoney(checkpoint.curveMinor)}</td>
                          <td>
                            {checkpoint.agrees ? (
                              "cuadra"
                            ) : (
                              <strong>{formatMoney(checkpoint.deltaMinor)}</strong>
                            )}
                          </td>
                          <td>
                            {checkpoint.governedBy === "rebaseline"
                              ? "tu saldo re-anclado"
                              : "el cuadro"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}

            <div aria-live="polite" className="importPreviewSummary">
              <p>{scheduleWriteSentence(plan)}</p>
              <p
                className={
                  scheduleVerdict(plan) === "verified" ? "infoNote" : "warningBand"
                }
                role={scheduleVerdict(plan) === "verified" ? undefined : "alert"}
              >
                {scheduleVerificationSentence(plan, formatMoney)}
              </p>
              {rebaselineNoticeSentence(plan) ? (
                <p className="infoNote">{rebaselineNoticeSentence(plan)}</p>
              ) : null}
              {plan.summary.outsideTermCount > 0 ? (
                <p className="warningBand" role="alert">
                  {pluralize(
                    plan.summary.outsideTermCount,
                    "fila cae después de la última cuota del plan y se queda fuera",
                    "filas caen después de la última cuota del plan y se quedan fuera",
                  )}
                  : el motor nunca las leería.
                </p>
              ) : null}
              <p className="infoNote">
                Confirmar escribe las revisiones y las amortizaciones todo o nada, sobre
                el plan que ya tienes — sus condiciones no se tocan — y recalcula la
                historia de la deuda de una vez.
              </p>
            </div>

            <ConfirmSubmit
              confirmAction={confirmAction}
              disabled={readOnly || !scheduleWritesSomething(plan)}
              label={
                scheduleWritesSomething(plan)
                  ? `Cargar ${scheduleWriteSentence(plan)}`
                  : "Nada que cargar"
              }
            />
          </div>
        ) : null}
      </form>
    </section>
  );
}

/**
 * Cobros hand-entry — the "Cobros" surface (PRD #652 S1, #656, ADR 0054).
 *
 * Sits on the ficha of any asset holding (income-side; never a liability). A
 * payout is a dated attribution record that this holding paid its owner — a pure
 * fact, NEVER a figure: it touches no snapshot, no ripple, no net-worth path.
 *
 * Server-rendered (interaction-patterns §11, ADR 0036): the figures — the trailing
 * passive-income strip and the month grid — are computed here; only the year
 * selector and the click→drawer are a client island (`CobrosGrid`). The two entry
 * forms (one-off + schedule) and the schedule-management controls are plain server
 * actions. Coverage vs declared spending is shown only when the scope has a FIRE
 * monthly-spending figure; otherwise it is omitted rather than invented.
 */

import { formatMoneyMinorPrivacy, passiveIncomeTrailing } from "@worthline/domain";
import type { CurrencyCode, Payout, PayoutSchedule } from "@worthline/domain";

import { PendingSubmit } from "@web/pending-submit";

import { CobrosGrid } from "./cobros-grid";
import { PAYOUT_CADENCE_LABELS } from "./cobros-form";
import { buildCobroRows } from "./cobros-view";

type FormAction = (formData: FormData) => void | Promise<void>;

const CADENCE_LABEL: Record<string, string> = Object.fromEntries(
  PAYOUT_CADENCE_LABELS.map(({ cadence, label }) => [cadence, label]),
);

const dayFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const formatDay = (iso: string) => dayFormatter.format(new Date(`${iso}T00:00:00Z`));

/** A one-line human spec for a schedule row (amount · cadence · window). */
function scheduleSpec(
  schedule: PayoutSchedule,
  fmt: (amountMinor: number) => string,
): string {
  const cadence = CADENCE_LABEL[schedule.cadence] ?? schedule.cadence;
  const window = schedule.endISO
    ? `${formatDay(schedule.startISO)} – ${formatDay(schedule.endISO)}`
    : `desde ${formatDay(schedule.startISO)}`;
  return `${fmt(schedule.amountMinor)} · ${cadence} · ${window}`;
}

export function CobrosSection({
  createPayoutAction,
  createPayoutScheduleAction,
  currency,
  currentUrl,
  deletePayoutAction,
  deletePayoutScheduleAction,
  error,
  monthlySpendingMinor,
  payouts,
  privacyMode,
  schedules,
  today,
  updatePayoutScheduleAction,
}: {
  createPayoutAction: FormAction;
  createPayoutScheduleAction: FormAction;
  currency: CurrencyCode;
  currentUrl: string;
  deletePayoutAction: FormAction;
  deletePayoutScheduleAction: FormAction;
  /** A validation error to surface at this section (formId "payout"). */
  error?: string | null;
  /** Declared monthly spending for the holding's scope, or null to omit coverage. */
  monthlySpendingMinor: number | null;
  payouts: Payout[];
  privacyMode: boolean;
  schedules: PayoutSchedule[];
  today: string;
  updatePayoutScheduleAction: FormAction;
}) {
  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);

  const rows = buildCobroRows(payouts, schedules, today);
  const passive = passiveIncomeTrailing(rows, today, 12);
  const annualSpending =
    monthlySpendingMinor != null && monthlySpendingMinor > 0
      ? monthlySpendingMinor * 12
      : null;
  const coverage = annualSpending ? passive.totalMinor / annualSpending : null;

  return (
    <section className="cobros" aria-label="Cobros">
      <h3>Cobros</h3>
      <p className="infoNote">
        Dividendos, intereses o alquileres que este activo te paga. Regístralos uno a uno
        o declara un cobro recurrente.
      </p>

      {error ? (
        <p className="errorBand" role="alert">
          {error}
        </p>
      ) : null}

      {/* Renta pasiva · trailing 12 months (server-rendered figure). */}
      <div className="cobrosPasiva">
        <div className="cobrosPasivaTop">
          <div>
            <div className="cobrosCap">Renta pasiva · últimos 12 meses</div>
            <div className="cobrosPasivaBig">{fmt(passive.totalMinor)}</div>
          </div>
          {coverage != null ? (
            <div className="cobrosPasivaCoverage">
              <div className="cobrosPasivaBig">{(coverage * 100).toFixed(1)} %</div>
              <div className="cobrosCap">de tu gasto declarado</div>
            </div>
          ) : null}
        </div>
        {coverage != null ? (
          <div className="cobrosPasivaBar">
            <i style={{ width: `${Math.min(100, coverage * 100)}%` }} />
          </div>
        ) : null}
        <p className="cobrosCap">
          Ventana: {formatDay(passive.windowStartISO)} – {formatDay(passive.windowEndISO)}{" "}
          · {passive.count} {passive.count === 1 ? "cobro" : "cobros"}
          {annualSpending ? ` · cobertura sobre ${fmt(annualSpending)}/año` : ""}. Sin
          anualizar cobros parciales.
        </p>
      </div>

      <CobrosGrid
        currency={currency}
        currentUrl={currentUrl}
        deletePayoutAction={deletePayoutAction}
        privacyMode={privacyMode}
        rows={rows}
        today={today}
        updatePayoutScheduleAction={updatePayoutScheduleAction}
      />

      {/* One-off entry (a variable dividend, an extraordinary distribution). */}
      <form action={createPayoutAction} className="stackForm cobrosForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <h4>Registrar un cobro puntual</h4>
        <div className="cobrosFormGrid">
          <label>
            Importe
            <input
              aria-label="Importe del cobro"
              defaultValue=""
              inputMode="decimal"
              name="amount"
              placeholder="0,00"
            />
          </label>
          <label>
            Fecha
            <input defaultValue={today} name="dateISO" type="date" />
          </label>
          <label>
            Nota
            <input
              aria-label="Nota del cobro"
              autoComplete="off"
              defaultValue=""
              name="note"
              placeholder="opcional"
            />
          </label>
        </div>
        <div className="formActions">
          <PendingSubmit pendingLabel="Guardando…">Añadir cobro</PendingSubmit>
        </div>
      </form>

      {/* Recurring schedule (a fixed rent, a fixed coupon). */}
      <form action={createPayoutScheduleAction} className="stackForm cobrosForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <h4>Declarar un cobro recurrente</h4>
        <div className="cobrosFormGrid">
          <label>
            Concepto
            <input
              aria-label="Concepto del cobro recurrente"
              autoComplete="off"
              defaultValue=""
              name="label"
              placeholder="Alquiler, cupón…"
            />
          </label>
          <label>
            Importe
            <input
              aria-label="Importe del cobro recurrente"
              defaultValue=""
              inputMode="decimal"
              name="amount"
              placeholder="0,00"
            />
          </label>
          <label>
            Cadencia
            <select defaultValue="monthly" name="cadence">
              {PAYOUT_CADENCE_LABELS.map(({ cadence, label }) => (
                <option key={cadence} value={cadence}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Desde
            <input defaultValue={today} name="startISO" type="date" />
          </label>
          <label>
            Hasta
            <input aria-label="Fecha de fin (opcional)" name="endISO" type="date" />
          </label>
        </div>
        <div className="formActions">
          <PendingSubmit pendingLabel="Guardando…">Añadir recurrente</PendingSubmit>
        </div>
      </form>

      {/* Declared schedules — end ("terminar hoy") or delete, per row. */}
      {schedules.length > 0 ? (
        <div className="cobrosSchedules">
          <h4>Cobros recurrentes declarados</h4>
          {schedules.map((schedule) => (
            <div className="cobrosSchedule" key={schedule.id}>
              <div className="cobrosScheduleMeta">
                <strong>{schedule.label}</strong>
                <span className="cobrosCap">{scheduleSpec(schedule, fmt)}</span>
              </div>
              <div className="cobrosScheduleActions">
                {schedule.endISO ? (
                  <form action={updatePayoutScheduleAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="scheduleId" type="hidden" value={schedule.id} />
                    <input name="clearEnd" type="hidden" value="1" />
                    <button className="btnSmall" type="submit">
                      Reactivar
                    </button>
                  </form>
                ) : (
                  <form action={updatePayoutScheduleAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="scheduleId" type="hidden" value={schedule.id} />
                    <input name="endISO" type="hidden" value={today} />
                    <button className="btnSmall" type="submit">
                      Terminar hoy
                    </button>
                  </form>
                )}
                <form action={deletePayoutScheduleAction}>
                  <input name="currentUrl" type="hidden" value={currentUrl} />
                  <input name="scheduleId" type="hidden" value={schedule.id} />
                  <button className="btnSmall btnWarning" type="submit">
                    Eliminar
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <p className="cobrosHonestNote">
        Un cobro es <strong>atribución, no contabilidad</strong>: no cambia tu patrimonio,
        ni el valor del holding, ni ningún cierre. Si el dinero nunca se reflejó en una
        cuenta, tu patrimonio no lo cuenta — el cobro solo explica de dónde viene.
      </p>
    </section>
  );
}

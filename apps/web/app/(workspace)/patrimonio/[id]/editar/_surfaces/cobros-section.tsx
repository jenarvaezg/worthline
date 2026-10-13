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

import { SeededChoice, SeededInput } from "@web/_components/form-seed";
import { seedChoicePane } from "@web/_components/form-seed-names";
import { FreshMark, FreshRow } from "@web/_components/fresh-rows";
import { IncomeDeclarationForm } from "@web/_income/income-declaration-form";
import { IncomeDeclarationSummary } from "@web/_income/income-declaration-summary";
import { PAYOUT_CADENCE_LABELS } from "@web/_income/income-recurrence";
import type { IncomeAction } from "@web/_income/optimistic-incomes";
import { COBRO_FORM_ID, type CobroFormId } from "@web/inversiones/cobro-form-ids";
import { PendingSubmit } from "@web/pending-submit";
import type { CurrencyCode, Payout, PayoutSchedule } from "@worthline/domain";
import {
  formatMoneyInput,
  formatMoneyMinorPrivacy,
  INCOME_DOUBLE_COUNT_CODE,
  passiveIncomeTrailing,
} from "@worthline/domain";
import Link from "next/link";
import type { ReactNode } from "react";
import { CobrosGrid } from "./cobros-grid";
import { buildCobroRows } from "./cobros-view";
import { LeaseTermsRow } from "./lease-terms-row";

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

/** A one-line human spec for a schedule row (amount · cadence · window · costs). */
function scheduleSpec(
  schedule: PayoutSchedule,
  fmt: (amountMinor: number) => string,
): string {
  const cadence = CADENCE_LABEL[schedule.cadence] ?? schedule.cadence;
  const window = schedule.endISO
    ? `${formatDay(schedule.startISO)} – ${formatDay(schedule.endISO)}`
    : `desde ${formatDay(schedule.startISO)}`;
  // The costs are named on the row because their ABSENCE is what keeps a rented
  // property on the FIRE tier default (#1448) — an invisible blank cannot explain
  // a rate that did not move.
  const costs =
    schedule.expensesMinor == null
      ? "sin gastos declarados"
      : `${fmt(schedule.expensesMinor)} de gastos`;
  return `${fmt(schedule.amountMinor)} · ${cadence} · ${window} · ${costs}`;
}

/** A Cobros form's refusal, as the URL brought it back. */
export interface CobroRefusal {
  form: CobroFormId;
  message: string;
  /** What the refused form had typed, by field name. */
  values: Readonly<Record<string, string>>;
}

/** The refusal when it is `form`'s own, so a form never prints another's. */
function refusalOf(
  refusal: CobroRefusal | null | undefined,
  form: CobroFormId,
): CobroRefusal | null {
  return refusal?.form === form ? refusal : null;
}

/** Everything the Cobros pieces take — one bag, so the three cuts cannot drift apart. */
export interface CobrosProps {
  /** «Es intencional» for the double-count cross (#1675) — the warnings' own door. */
  acknowledgeWarningAction: FormAction;
  /**
   * The door to add the first cobro, where the entry forms are NOT on the same
   * surface (#1830): the tabbed ficha's Cobros tab, whose forms live in the
   * «Añadir cobro» panel. Printed only while the holding has none.
   */
  addLink?: ReactNode;
  /**
   * The income declaration door with this holding bound (#1673): the same action,
   * parser and required provenance as the Rentas surface. Redirects on success and
   * hands a refusal back as state (#1311).
   */
  createIncomeAction: IncomeAction;
  createPayoutAction: FormAction;
  currency: CurrencyCode;
  currentUrl: string;
  deletePayoutAction: FormAction;
  deletePayoutScheduleAction: FormAction;
  /**
   * The double-count cross (#1675): the sentence that names this holding's value and
   * the income linked to it, or null when there is nothing to cross or the user
   * already said it is intentional. Decided by the loader, which knows the holding.
   */
  doubleCount: string | null;
  /**
   * A refusal that came back on the URL, and which Cobros form it is from
   * (`cobro-form-ids.ts`): each form prints its own and refills what was typed —
   * the entry's one-off and recurring forms, or the record's controls (#1731 review).
   */
  refusal?: CobroRefusal | null;
  /** The holding this section sits on — the link every income declared here gets. */
  holdingId: string;
  /** Declared monthly spending for the holding's scope, or null to omit coverage. */
  monthlySpendingMinor: number | null;
  payouts: Payout[];
  privacyMode: boolean;
  /** Demo: the declaration door posts plainly and fakes no optimism (§10). */
  readOnly?: boolean;
  schedules: PayoutSchedule[];
  /**
   * Whether this holding's income can be a LEASE (#1521) — decided by the caller,
   * which knows the instrument. A coupon's end date means what it says, so offering
   * it a rental regime would invite a declaration that decides nothing.
   */
  showLeaseTerms: boolean;
  today: string;
  updatePayoutScheduleAction: FormAction;
}

/**
 * The record half (#1826): what this holding has paid and what it is declared to
 * pay — the ficha's «Cobros» tab. It is the `#cobros` fragment `holdingCobrosHref`
 * lands on, and where a refusal of the record's own controls (a schedule's costs,
 * its lease terms) is printed: the ficha opens on this tab when one comes back. An
 * entry form's refusal goes back to the entry instead (#1731 review).
 */
export function CobrosRecord(props: CobrosProps) {
  return (
    <section className="cobros" aria-label="Cobros" id="cobros" tabIndex={-1}>
      <CobrosAlerts {...props} />
      <CobrosSummary {...props} />
      <CobrosSchedules {...props} />
      {/* What a cobro is matters once there is one to read; the empty record is
          one line (#1830), and the entry panel says it before its forms. */}
      {hasNoCobros(props) ? null : <CobrosHonestNote />}
    </section>
  );
}

/** The two kinds of cobro the «Añadir cobro» panel asks between (#1829). */
const COBRO_KIND = "cobroKind";

/**
 * The entry half (#1826): the two ways to add one — a one-off payment or a
 * recurring income — for the ficha's «Añadir cobro» panel.
 *
 * It asks first which one (#1829) and shows only that form: the two used to stand
 * one after the other, some 1.000 px of fields for a dividend that needs three. The
 * choice is a `.segmented` of radios whose pane shows through CSS (`:has()`), so it
 * switches without a round-trip and works without JavaScript; it starts on the
 * one-off — a fund's habitual cobro is a dividend — unless «Añadir otro» re-opened
 * the panel on the recurring one, or the recurring one is what was refused (#1731
 * review). Each pane names its variant (`data-seed-choice`, `SEED_CHOICE_ATTRIBUTE`),
 * which is how the ficha tells which one was sent.
 */
export function CobrosEntry(props: CobrosProps) {
  const startsOn = refusalOf(props.refusal, COBRO_FORM_ID.recurring)
    ? "recurrente"
    : "suelto";
  return (
    <section className="cobros cobroKindChoice" aria-label="Añadir cobro">
      <CobrosIntro />
      <fieldset className="segmented cobroKind">
        <legend className="srOnly">Qué cobro quieres añadir</legend>
        <SeededChoice defaultChoice={startsOn} name={COBRO_KIND} value="suelto">
          Un cobro suelto
        </SeededChoice>
        <SeededChoice defaultChoice={startsOn} name={COBRO_KIND} value="recurrente">
          Uno que se repite
        </SeededChoice>
      </fieldset>
      <div className="cobroKindPane" {...seedChoicePane("suelto")}>
        <CobrosOneOffForm {...props} />
      </div>
      <div className="cobroKindPane" {...seedChoicePane("recurrente")}>
        <CobrosRecurringForm {...props} />
      </div>
    </section>
  );
}

function CobrosIntro() {
  return (
    <p className="infoNote">
      Dividendos, intereses o alquileres que este activo te paga. Regístralos uno a uno o
      declara un cobro recurrente.
    </p>
  );
}

function moneyIn(currency: CurrencyCode, privacyMode: boolean) {
  return (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
}

/** A refusal of the record's own controls, and the double-count cross (#1675). */
function CobrosAlerts({
  acknowledgeWarningAction,
  currentUrl,
  doubleCount,
  holdingId,
  readOnly = false,
  refusal,
}: CobrosProps) {
  const own = refusalOf(refusal, COBRO_FORM_ID.record);
  return (
    <>
      {own ? (
        <p className="errorBand" role="alert">
          {own.message}
        </p>
      ) : null}

      {/* The double-count cross (#1675), beside the incomes it is about: the user is
          the one who knows whether the income is paid out of this capital or is what
          it yields, so the legitimate case is acknowledged here, once. */}
      {doubleCount ? (
        <div className="warningBand" role="status" aria-label="Posible doble conteo">
          <div className="warningItem">
            <span>⚠ {doubleCount}</span>
            <form action={acknowledgeWarningAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="code" type="hidden" value={INCOME_DOUBLE_COUNT_CODE} />
              <input name="entityId" type="hidden" value={holdingId} />
              <button className="btnSmall btnWarning" disabled={readOnly} type="submit">
                Es intencional
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Nothing paid and nothing declared: there is no figure to sum, only a fact to say. */
function hasNoCobros({ payouts, schedules }: Pick<CobrosProps, "payouts" | "schedules">) {
  return payouts.length === 0 && schedules.length === 0;
}

/**
 * Renta pasiva · trailing 12 months (server-rendered figure), then the month grid —
 * or, for a holding that never paid anything, one line saying so (#1830): a strip at
 * 0 €, a 0,0 % coverage and a year of empty months were a block of zeros that read
 * as a measurement when it was an absence.
 */
function CobrosSummary({
  addLink,
  currency,
  currentUrl,
  deletePayoutAction,
  monthlySpendingMinor,
  payouts,
  privacyMode,
  schedules,
  today,
  updatePayoutScheduleAction,
}: CobrosProps) {
  if (hasNoCobros({ payouts, schedules })) {
    return (
      <p className="emptyLine cobrosEmpty">
        Este activo no ha pagado nada todavía.
        {addLink ? <> {addLink}</> : null}
      </p>
    );
  }

  const fmt = moneyIn(currency, privacyMode);
  const rows = buildCobroRows(payouts, schedules, today);
  const passive = passiveIncomeTrailing(rows, today, 12);
  const annualSpending =
    monthlySpendingMinor != null && monthlySpendingMinor > 0
      ? monthlySpendingMinor * 12
      : null;
  // Coverage decides something — it runs on NET (#1463), same rule as /objetivos.
  const coverage = annualSpending ? passive.netMinor / annualSpending : null;

  return (
    <>
      <div className="cobrosPasiva">
        <div className="cobrosPasivaTop">
          <div>
            {/* Neto como titular (#1463); el bruto baja a la sub-línea cuando difieran. */}
            <div className="cobrosCap">
              {passive.expensesMinor > 0
                ? "Renta pasiva neta · últimos 12 meses"
                : "Renta pasiva · últimos 12 meses"}
            </div>
            <div className="cobrosPasivaBig">{fmt(passive.netMinor)}</div>
            {passive.expensesMinor > 0 ? (
              <div className="cobrosCap">
                brutos {fmt(passive.totalMinor)} − gastos declarados{" "}
                {fmt(passive.expensesMinor)}
              </div>
            ) : null}
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
            {/* Un neto negativo (gastos > renta) es declarable: la barra se queda a 0. */}
            <i style={{ width: `${Math.min(100, Math.max(0, coverage * 100))}%` }} />
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
    </>
  );
}

/**
 * One-off entry (a variable dividend, an extraordinary distribution). Its refusal
 * comes back by redirect, so it is printed here, over the fields it refills (#1731
 * review) — the recurring form does the same with its own.
 */
function CobrosOneOffForm({
  createPayoutAction,
  currentUrl,
  refusal,
  today,
}: CobrosProps) {
  const refused = refusalOf(refusal, COBRO_FORM_ID.oneOff);
  const typed = (name: string) => refused?.values[name] ?? "";
  return (
    <form action={createPayoutAction} className="stackForm cobrosForm">
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <h4>Registrar un cobro puntual</h4>
      {refused ? (
        <p className="formError" role="alert">
          {refused.message}
        </p>
      ) : null}
      <div className="cobrosFormGrid">
        <label>
          Importe
          <input
            aria-label="Importe del cobro"
            defaultValue={typed("amount")}
            inputMode="decimal"
            name="amount"
            placeholder="0,00"
          />
        </label>
        <label>
          Fecha
          {/* «Añadir otro» re-opens it on the day of the cobro just added (#1829). */}
          <SeededInput
            fallback={refused?.values.dateISO ?? today}
            name="dateISO"
            type="date"
          />
        </label>
        <label>
          Nota
          <input
            aria-label="Nota del cobro"
            autoComplete="off"
            defaultValue={typed("note")}
            name="note"
            placeholder="opcional"
          />
        </label>
      </div>
      <div className="formActions">
        <PendingSubmit pendingLabel="Guardando…">Añadir cobro</PendingSubmit>
      </div>
    </form>
  );
}

/**
 * Recurring income (a fixed rent, a fixed coupon) — the same declaration door as
 * the Rentas surface, with this holding already linked (#1673): same parser, same
 * required provenance, nature and basis opening on «Sin declarar». The lease terms
 * appear only where a lease is what this income is (#1521).
 */
function CobrosRecurringForm({
  createIncomeAction,
  currentUrl,
  holdingId,
  readOnly = false,
  refusal,
  showLeaseTerms,
  today,
}: CobrosProps) {
  // A no-JS refusal, printed and refilled by the form itself (with JS it is state).
  const refused = refusalOf(refusal, COBRO_FORM_ID.recurring);
  return (
    <div className="cobrosForm">
      <IncomeDeclarationForm
        accessibleSuffix=" del cobro recurrente"
        action={createIncomeAction}
        currentUrl={currentUrl}
        holdingId={holdingId}
        initialError={refused?.message ?? null}
        initialValues={refused?.values ?? {}}
        readOnly={readOnly}
        showLeaseTerms={showLeaseTerms}
        submitLabel="Añadir recurrente"
        title="Declarar un cobro recurrente"
        today={today}
      />
    </div>
  );
}

/** Declared schedules — end ("terminar hoy") or delete, per row. */
function CobrosSchedules({
  currency,
  currentUrl,
  deletePayoutScheduleAction,
  privacyMode,
  schedules,
  showLeaseTerms,
  today,
  updatePayoutScheduleAction,
}: CobrosProps) {
  if (schedules.length === 0) {
    return null;
  }
  const fmt = moneyIn(currency, privacyMode);

  return (
    <div className="cobrosSchedules">
      <h4>Cobros recurrentes declarados</h4>
      {schedules.map((schedule) => (
        // The one just declared is pointed at here (#1731 review): its occurrences
        // in the grid are several, or none yet, so the declaration is the new row.
        <FreshRow
          className="cobrosSchedule"
          key={schedule.id}
          list="recurrentes"
          rowKey={schedule.id}
        >
          <div className="cobrosScheduleTop">
            <div className="cobrosScheduleMeta">
              <strong>
                {schedule.label}
                <FreshMark list="recurrentes" rowKey={schedule.id} word="nuevo" />
              </strong>
              <span className="cobrosCap">{scheduleSpec(schedule, fmt)}</span>
            </div>
            <div className="cobrosScheduleActions">
              {/* Declare (or correct) the costs of an existing rent without
                  re-entering it: the four rents Jorge already had were declared
                  before this field existed. */}
              <form action={updatePayoutScheduleAction} className="cobrosExpensesForm">
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <input name="scheduleId" type="hidden" value={schedule.id} />
                <input name="saveExpenses" type="hidden" value="1" />
                <label>
                  Gastos
                  <input
                    aria-label={`Gastos de ${schedule.label}`}
                    defaultValue={
                      schedule.expensesMinor == null
                        ? ""
                        : formatMoneyInput(schedule.expensesMinor)
                    }
                    inputMode="decimal"
                    name="expenses"
                  />
                </label>
                <button className="btnSmall" type="submit">
                  Guardar gastos
                </button>
              </form>
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
          {/* Whether it counts and why not, what it declares and where its figure
              comes from — the same summary the Rentas list prints (#1673). The
              declaration is corrected there. */}
          <IncomeDeclarationSummary income={schedule} today={today}>
            {" · "}
            <Link href="/objetivos/rentas">Corregir su declaración en Rentas</Link>
          </IncomeDeclarationSummary>
          {/* What the end date MEANS, and what happens after it (#1521). Below
              the row rather than inside it: the sentence it prints is about the
              rent's future, not another button. */}
          {showLeaseTerms ? (
            <LeaseTermsRow
              action={updatePayoutScheduleAction}
              currentUrl={currentUrl}
              schedule={schedule}
            />
          ) : null}
        </FreshRow>
      ))}
    </div>
  );
}

function CobrosHonestNote() {
  return (
    <p className="cobrosHonestNote">
      Un cobro es <strong>atribución, no contabilidad</strong>: no cambia tu patrimonio,
      ni el valor del holding, ni ningún cierre. Si el dinero nunca se reflejó en una
      cuenta, tu patrimonio no lo cuenta — el cobro solo explica de dónde viene.
    </p>
  );
}

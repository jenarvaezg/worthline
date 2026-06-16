/**
 * Debt-model editor — the `amortized` + `anchored` surfaces (PRD #109, #152).
 *
 * Only rendered for liabilities. All forms are server-action driven (no client
 * JS, ADR 0009): the model selector posts and the page re-renders the matching
 * sub-section from the stored `debt_model` (server-side conditional, no
 * useState). `amortizable` → the plan editor (amortized); `revolving`/`informal`
 * → the balance-anchor editor (anchored). Inline edit uses <details>, delete is
 * two-step. Extracted from the monolithic editar page.
 */

import type {
  AmortizationPlanRecord,
  BalanceAnchorRecord,
  EarlyRepaymentRecord,
  InterestRateRevisionRecord,
} from "@worthline/db";
import { firstCuota, formatMoneyInput, formatMoneyMinor } from "@worthline/domain";
import type { DebtModel, EarlyRepaymentMode } from "@worthline/domain";

import type { FormErrorContext } from "../../../../intake";
import { PlanDateFields } from "./plan-date-fields";
import {
  addBalanceAnchorAction,
  addEarlyRepaymentAction,
  addInterestRateRevisionAction,
  deleteAmortizationPlanAction,
  deleteBalanceAnchorAction,
  deleteEarlyRepaymentAction,
  deleteInterestRateRevisionAction,
  saveAmortizationPlanAction,
  setDebtModelAction,
  updateBalanceAnchorAction,
  updateEarlyRepaymentAction,
  updateInterestRateRevisionAction,
} from "../../../actions";

/** Render a stored decimal rate ("0.025") back as the percent the user typed ("2.5"). */
function rateToPercent(rate: string): string {
  const pct = Number(rate) * 100;

  return String(Math.round(pct * 1_000_000) / 1_000_000);
}

/**
 * Cents-precise es-ES euro display for a cuota. `formatMoneyMinor` drops the cents
 * (it is for whole-euro totals); a cuota is exact to the cent (ADR 0019), so the
 * stub-interest figure and the first cuota are shown with two decimals.
 */
function formatEurCents(amountMinor: number): string {
  return new Intl.NumberFormat("es-ES", {
    currency: "EUR",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
}

/**
 * Whole days between two YYYY-MM-DD dates (UTC midnights). Mirrors the domain
 * engine's day count so the displayed opening-period length matches the days the
 * stub interest is computed from (ADR 0019, #190).
 */
function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);

  return Math.round((toMs - fromMs) / 86_400_000);
}

/**
 * The exact first cuota with its stub interest, derived on demand from the plan
 * (ADR 0019, #190). DISPLAY ONLY: the `firstCuota` helper never feeds the balance
 * curve, snapshots, or net worth — this enlarges the *displayed* first cuota, not
 * the modeled balance. The opening period (disbursement → first payment) is longer
 * than a month, so the first cuota carries that period's stub interest on top of
 * the ordinary French principal; subsequent cuotas are the regular cuota.
 */
function PlanCuotaSummary({ plan }: { plan: AmortizationPlanRecord }) {
  const cuota = firstCuota({
    annualInterestRate: plan.annualInterestRate,
    disbursementDate: plan.disbursementDate,
    firstPaymentDate: plan.firstPaymentDate,
    initialCapitalMinor: plan.initialCapitalMinor,
    termMonths: plan.termMonths,
  });
  const stubDays = daysBetween(plan.disbursementDate, plan.firstPaymentDate);

  return (
    <section className="planCuota" aria-label="Cuotas del préstamo">
      <h4>Cuotas</h4>
      <dl className="planCuotaGrid">
        <div className="planCuotaItem">
          <dt>Primera cuota</dt>
          <dd className="planCuotaFigure">{formatEurCents(cuota.amountMinor)}</dd>
        </div>
        <div className="planCuotaItem">
          <dt>Cuota habitual</dt>
          <dd className="planCuotaFigure">{formatEurCents(cuota.regularCuotaMinor)}</dd>
        </div>
      </dl>
      <p className="infoNote">
        La primera cuota incluye el interés del periodo de apertura ({stubDays} días, del{" "}
        {plan.disbursementDate} al {plan.firstPaymentDate}):{" "}
        {formatEurCents(cuota.stubInterestMinor)} de intereses más{" "}
        {formatEurCents(cuota.firstPrincipalMinor)} de capital. No altera el saldo del
        histórico.
      </p>
    </section>
  );
}

const DEBT_MODEL_LABELS: Record<DebtModel, string> = {
  amortizable: "Amortizable (préstamo francés)",
  informal: "Informal",
  revolving: "Revolving",
};

export function DebtModelSection({
  amortizationPlan,
  balanceAnchors,
  debtModel,
  earlyRepayments,
  formError,
  liabilityId,
  rateRevisions,
  today,
}: {
  amortizationPlan: AmortizationPlanRecord | null;
  balanceAnchors: BalanceAnchorRecord[];
  debtModel: DebtModel | null;
  earlyRepayments: EarlyRepaymentRecord[];
  formError: FormErrorContext | null;
  liabilityId: string;
  rateRevisions: InterestRateRevisionRecord[];
  today: string;
}) {
  const currentUrl = `/patrimonio/${liabilityId}/editar`;

  return (
    <section className="debtModel" aria-label="Modelo de deuda">
      <h3>Modelo de deuda</h3>

      <form action={setDebtModelAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={liabilityId} />
        <label>
          Modelo de deuda
          <select
            aria-label="Modelo de deuda"
            defaultValue={debtModel ?? ""}
            name="debtModel"
          >
            <option value="">Sin modelo</option>
            <option value="amortizable">{DEBT_MODEL_LABELS.amortizable}</option>
            <option value="revolving">{DEBT_MODEL_LABELS.revolving}</option>
            <option value="informal">{DEBT_MODEL_LABELS.informal}</option>
          </select>
        </label>
        <p className="infoNote">
          Elige cómo evoluciona el saldo de la deuda en el histórico. Al cambiarlo se
          muestra el formulario correspondiente.
        </p>
        <button type="submit">Guardar modelo</button>
      </form>

      {debtModel === "amortizable" ? (
        <AmortizablePlanEditor
          currentUrl={currentUrl}
          earlyRepayments={earlyRepayments}
          formError={formError}
          liabilityId={liabilityId}
          plan={amortizationPlan}
          rateRevisions={rateRevisions}
          today={today}
        />
      ) : null}

      {debtModel === "revolving" || debtModel === "informal" ? (
        <BalanceAnchorEditor
          balanceAnchors={balanceAnchors}
          currentUrl={currentUrl}
          formError={formError}
          liabilityId={liabilityId}
          today={today}
        />
      ) : null}
    </section>
  );
}

/** Shared plan fields for the create/edit amortization-plan form. */
function PlanFields({ max, values }: { max: string; values: Record<string, string> }) {
  return (
    <>
      <label>
        Capital inicial (EUR)
        <input
          aria-label="Capital inicial en EUR"
          defaultValue={values["initialCapital"]}
          inputMode="decimal"
          min="0"
          name="initialCapital"
          placeholder="200.000"
          required
        />
      </label>
      <label>
        Tipo de interés anual (%)
        <input
          aria-label="Tipo de interés anual (%)"
          defaultValue={values["annualInterestRate"]}
          inputMode="decimal"
          min="0"
          name="annualInterestRate"
          placeholder="2,5"
          required
        />
      </label>
      <label>
        Plazo (meses)
        <input
          aria-label="Plazo en meses"
          defaultValue={values["termMonths"]}
          inputMode="numeric"
          min="1"
          name="termMonths"
          placeholder="360"
          required
          step="1"
        />
      </label>
      <PlanDateFields
        initialDisbursement={values["disbursementDate"] ?? ""}
        initialFirstPayment={values["firstPaymentDate"] ?? ""}
        max={max}
      />
    </>
  );
}

/**
 * The amortizable sub-section: the plan (create or edit), its rate revisions, and
 * its early repayments (amortización anticipada, PRD #146 / #150).
 */
function AmortizablePlanEditor({
  currentUrl,
  earlyRepayments,
  formError,
  liabilityId,
  plan,
  rateRevisions,
  today,
}: {
  currentUrl: string;
  earlyRepayments: EarlyRepaymentRecord[];
  formError: FormErrorContext | null;
  liabilityId: string;
  plan: AmortizationPlanRecord | null;
  rateRevisions: InterestRateRevisionRecord[];
  today: string;
}) {
  const planValues =
    formError?.formId === "plan"
      ? formError.values
      : plan
        ? {
            annualInterestRate: rateToPercent(plan.annualInterestRate),
            disbursementDate: plan.disbursementDate,
            firstPaymentDate: plan.firstPaymentDate,
            initialCapital: formatMoneyInput(plan.initialCapitalMinor),
            termMonths: String(plan.termMonths),
          }
        : {};
  const revisionValues = formError?.formId === "revision" ? formError.values : {};
  const repaymentValues = formError?.formId === "repayment" ? formError.values : {};
  const sortedRepayments = [...earlyRepayments].sort((a, b) =>
    b.repaymentDate.localeCompare(a.repaymentDate),
  );
  const sortedRevisions = [...rateRevisions].sort((a, b) =>
    b.revisionDate.localeCompare(a.revisionDate),
  );

  return (
    <div className="debtModelDetail">
      <form
        action={saveAmortizationPlanAction}
        aria-label="Plan de amortización"
        className="stackForm"
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={liabilityId} />
        <PlanFields max={today} values={planValues} />
        <div className="formActions">
          <button type="submit">{plan ? "Actualizar plan" : "Guardar plan"}</button>
        </div>
      </form>

      {plan ? (
        <form action={deleteAmortizationPlanAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="planId" type="hidden" value={plan.id} />
          <details className="confirmDelete">
            <summary>Eliminar plan</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      ) : null}

      {plan ? <PlanCuotaSummary plan={plan} /> : null}

      {plan ? (
        <>
          <h4>Revisiones de tipo</h4>
          <form
            action={addInterestRateRevisionAction}
            aria-label="Registrar revisión de tipo"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="planId" type="hidden" value={plan.id} />
            <RevisionFields max={today} values={revisionValues} />
            <button type="submit">Registrar revisión</button>
          </form>

          {sortedRevisions.length > 0 ? (
            <div className="tableScroll">
              <table aria-label="Revisiones de tipo">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th className="numCol">Nuevo tipo</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRevisions.map((revision) => (
                    <RevisionRow
                      currentUrl={currentUrl}
                      formError={formError}
                      key={revision.id}
                      liabilityId={liabilityId}
                      max={today}
                      planId={plan.id}
                      revision={revision}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="emptyLine">Sin revisiones de tipo registradas.</p>
          )}
        </>
      ) : null}

      {plan ? (
        <>
          <h4>Amortizaciones anticipadas</h4>
          <form
            action={addEarlyRepaymentAction}
            aria-label="Registrar amortización anticipada"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="planId" type="hidden" value={plan.id} />
            <EarlyRepaymentFields max={today} values={repaymentValues} />
            <button type="submit">Registrar amortización</button>
          </form>

          {sortedRepayments.length > 0 ? (
            <div className="tableScroll">
              <table aria-label="Amortizaciones anticipadas">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th className="numCol">Importe</th>
                    <th>Tipo</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRepayments.map((repayment) => (
                    <EarlyRepaymentRow
                      currentUrl={currentUrl}
                      formError={formError}
                      key={repayment.id}
                      liabilityId={liabilityId}
                      max={today}
                      planId={plan.id}
                      repayment={repayment}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="emptyLine">Sin amortizaciones anticipadas registradas.</p>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Shared date / rate fields for the add and edit revision forms. */
function RevisionFields({
  max,
  values,
}: {
  max: string;
  values: Record<string, string>;
}) {
  return (
    <>
      <label>
        Fecha de la revisión
        <input
          aria-label="Fecha de la revisión"
          defaultValue={values["revisionDate"]}
          max={max}
          name="revisionDate"
          required
          type="date"
        />
      </label>
      <label>
        Nuevo tipo de interés (%)
        <input
          aria-label="Nuevo tipo de interés (%)"
          defaultValue={values["newAnnualInterestRate"]}
          inputMode="decimal"
          min="0"
          name="newAnnualInterestRate"
          placeholder="3"
          required
        />
      </label>
    </>
  );
}

/** One revision row: data + inline edit (<details>) + two-step delete. */
function RevisionRow({
  currentUrl,
  formError,
  liabilityId,
  max,
  planId,
  revision,
}: {
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  max: string;
  planId: string;
  revision: InterestRateRevisionRecord;
}) {
  const editFormId = `revision-${revision.id}`;
  const editing = formError?.formId === editFormId;
  const editValues = editing
    ? formError.values
    : {
        newAnnualInterestRate: rateToPercent(revision.newAnnualInterestRate),
        revisionDate: revision.revisionDate,
      };

  return (
    <tr>
      <td>{revision.revisionDate}</td>
      <td className="numCol">{rateToPercent(revision.newAnnualInterestRate)} %</td>
      <td className="rowActions">
        <details className="anchorEdit" open={editing}>
          <summary>Editar</summary>
          <form
            action={updateInterestRateRevisionAction}
            aria-label="Editar revisión de tipo"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="planId" type="hidden" value={planId} />
            <input name="revisionId" type="hidden" value={revision.id} />
            <RevisionFields max={max} values={editValues} />
            <div className="formActions">
              <button type="submit">Guardar revisión</button>
            </div>
          </form>
        </details>
        <form action={deleteInterestRateRevisionAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="planId" type="hidden" value={planId} />
          <input name="revisionId" type="hidden" value={revision.id} />
          <details className="confirmDelete">
            <summary>Eliminar</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      </td>
    </tr>
  );
}

const EARLY_REPAYMENT_MODE_LABELS: Record<EarlyRepaymentMode, string> = {
  "reduce-payment": "Reducir cuota",
  "reduce-term": "Reducir plazo",
};

/** Shared date / amount / mode fields for the add and edit early-repayment forms. */
function EarlyRepaymentFields({
  max,
  values,
}: {
  max: string;
  values: Record<string, string>;
}) {
  return (
    <>
      <label>
        Fecha de la amortización
        <input
          aria-label="Fecha de la amortización"
          defaultValue={values["repaymentDate"]}
          max={max}
          name="repaymentDate"
          required
          type="date"
        />
      </label>
      <label>
        Importe en EUR
        <input
          aria-label="Importe en EUR"
          defaultValue={values["amount"]}
          inputMode="decimal"
          min="0"
          name="amount"
          placeholder="10000"
          required
        />
      </label>
      <label>
        Tipo de amortización
        <select
          aria-label="Tipo de amortización"
          defaultValue={values["mode"] ?? "reduce-payment"}
          name="mode"
        >
          <option value="reduce-payment">
            {EARLY_REPAYMENT_MODE_LABELS["reduce-payment"]}
          </option>
          <option value="reduce-term">
            {EARLY_REPAYMENT_MODE_LABELS["reduce-term"]}
          </option>
        </select>
      </label>
    </>
  );
}

/** One early-repayment row: data + inline edit (<details>) + two-step delete. */
function EarlyRepaymentRow({
  currentUrl,
  formError,
  liabilityId,
  max,
  planId,
  repayment,
}: {
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  max: string;
  planId: string;
  repayment: EarlyRepaymentRecord;
}) {
  const editFormId = `repayment-${repayment.id}`;
  const editing = formError?.formId === editFormId;
  const editValues = editing
    ? formError.values
    : {
        amount: formatMoneyInput(repayment.amountMinor),
        mode: repayment.mode,
        repaymentDate: repayment.repaymentDate,
      };

  return (
    <tr>
      <td>{repayment.repaymentDate}</td>
      <td className="numCol">
        {formatMoneyMinor({ amountMinor: repayment.amountMinor, currency: "EUR" })}
      </td>
      <td>{EARLY_REPAYMENT_MODE_LABELS[repayment.mode]}</td>
      <td className="rowActions">
        <details className="anchorEdit" open={editing}>
          <summary>Editar</summary>
          <form
            action={updateEarlyRepaymentAction}
            aria-label="Editar amortización anticipada"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="planId" type="hidden" value={planId} />
            <input name="repaymentId" type="hidden" value={repayment.id} />
            <EarlyRepaymentFields max={max} values={editValues} />
            <div className="formActions">
              <button type="submit">Guardar amortización</button>
            </div>
          </form>
        </details>
        <form action={deleteEarlyRepaymentAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="planId" type="hidden" value={planId} />
          <input name="repaymentId" type="hidden" value={repayment.id} />
          <details className="confirmDelete">
            <summary>Eliminar</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      </td>
    </tr>
  );
}

/** Shared date / balance fields for the add and edit balance-anchor forms. */
function BalanceAnchorFields({
  max,
  values,
}: {
  max: string;
  values: Record<string, string>;
}) {
  return (
    <>
      <label>
        Fecha del saldo
        <input
          aria-label="Fecha del saldo"
          defaultValue={values["anchorDate"]}
          max={max}
          name="anchorDate"
          required
          type="date"
        />
      </label>
      <label>
        Saldo restante (EUR)
        <input
          aria-label="Saldo restante en EUR"
          defaultValue={values["balance"]}
          inputMode="decimal"
          min="0"
          name="balance"
          placeholder="12.500"
          required
        />
      </label>
    </>
  );
}

/** The revolving/informal sub-section: declare a balance anchor + list them. */
function BalanceAnchorEditor({
  balanceAnchors,
  currentUrl,
  formError,
  liabilityId,
  today,
}: {
  balanceAnchors: BalanceAnchorRecord[];
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  today: string;
}) {
  const anchorValues = formError?.formId === "balanceAnchor" ? formError.values : {};
  const sorted = [...balanceAnchors].sort((a, b) =>
    b.anchorDate.localeCompare(a.anchorDate),
  );

  return (
    <div className="debtModelDetail">
      <h4>Saldos declarados</h4>
      <form
        action={addBalanceAnchorAction}
        aria-label="Registrar saldo"
        className="stackForm"
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={liabilityId} />
        <BalanceAnchorFields max={today} values={anchorValues} />
        <p className="infoNote">
          Declara el total adeudado en esa fecha (intereses incluidos).
        </p>
        <button type="submit">Registrar saldo</button>
      </form>

      {sorted.length > 0 ? (
        <div className="tableScroll">
          <table aria-label="Saldos declarados">
            <thead>
              <tr>
                <th>Fecha</th>
                <th className="numCol">Saldo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((anchor) => (
                <BalanceAnchorRow
                  anchor={anchor}
                  currentUrl={currentUrl}
                  formError={formError}
                  key={anchor.id}
                  liabilityId={liabilityId}
                  max={today}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="emptyLine">Sin saldos declarados.</p>
      )}
    </div>
  );
}

/** One balance-anchor row: data + inline edit (<details>) + two-step delete. */
function BalanceAnchorRow({
  anchor,
  currentUrl,
  formError,
  liabilityId,
  max,
}: {
  anchor: BalanceAnchorRecord;
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  max: string;
}) {
  const editFormId = `balanceAnchor-${anchor.id}`;
  const editing = formError?.formId === editFormId;
  const editValues = editing
    ? formError.values
    : {
        anchorDate: anchor.anchorDate,
        balance: formatMoneyInput(anchor.balanceMinor),
      };

  return (
    <tr>
      <td>{anchor.anchorDate}</td>
      <td className="numCol">
        {formatMoneyMinor({ amountMinor: anchor.balanceMinor, currency: "EUR" })}
      </td>
      <td className="rowActions">
        <details className="anchorEdit" open={editing}>
          <summary>Editar</summary>
          <form
            action={updateBalanceAnchorAction}
            aria-label="Editar saldo"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="anchorId" type="hidden" value={anchor.id} />
            <BalanceAnchorFields max={max} values={editValues} />
            <div className="formActions">
              <button type="submit">Guardar saldo</button>
            </div>
          </form>
        </details>
        <form action={deleteBalanceAnchorAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="anchorId" type="hidden" value={anchor.id} />
          <details className="confirmDelete">
            <summary>Eliminar</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      </td>
    </tr>
  );
}

/**
 * The liability ficha (PRD #109) — since #1848 a tabbed ficha whose bar and tabs
 * follow the debt's model (`debt-ficha-shape`).
 *
 * The header says what is owed, first: the board row's figure, from the same
 * function the board assembles its curve input with (`debtBalanceCurveInput`, the
 * same `debtBalanceAtDate`), never the raw stored column of a debt the curve
 * governs. Under it, the model — or that there is none, with the door to choose one
 * — and what the model makes worth knowing: the cuota in force for an amortizable
 * debt (`debtServiceAtDate`, so it follows the rate revisions the balance follows,
 * #1520), the last declared balance for a revolving or informal one.
 *
 * What this loader owns is which rows the ficha needs and the fact that they hang
 * off each other — plan and re-baselines off the liability, revisions and early
 * repayments off the plan (#446). Both waves are needed even when one comes back
 * empty: a re-baseline alone can govern the curve with no plan row (ADR 0056, #678).
 */

import { FichaLink } from "@web/patrimonio/[id]/editar/_ficha/ficha-link";
import {
  FICHA_DATOS_TAB,
  fichaActionUrl,
  fichaTabUrl,
} from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import {
  ANCHORS_ROW_LIST,
  BalanceAnchorForm,
  BalanceAnchorsTable,
} from "@web/patrimonio/[id]/editar/_surfaces/debt-anchors-section";
import {
  DEBT_FORM_ID,
  DEBT_PANEL_FORM_IDS,
  rowFormId,
} from "@web/patrimonio/[id]/editar/_surfaces/debt-form-ids";
import {
  DEBT_MODEL_LABELS,
  formatEurCentsPrivacy,
} from "@web/patrimonio/[id]/editar/_surfaces/debt-format";
import { DebtModelForm } from "@web/patrimonio/[id]/editar/_surfaces/debt-model-form";
import { DebtPlanSection } from "@web/patrimonio/[id]/editar/_surfaces/debt-plan-section";
import { DebtRecalibrateForm } from "@web/patrimonio/[id]/editar/_surfaces/debt-recalibrate-form";
import {
  EarlyRepaymentForm,
  EarlyRepaymentsTable,
  REPAYMENTS_ROW_LIST,
} from "@web/patrimonio/[id]/editar/_surfaces/debt-repayments-section";
import {
  REVISIONS_ROW_LIST,
  RevisionForm,
  RevisionsTable,
} from "@web/patrimonio/[id]/editar/_surfaces/debt-revisions-section";
import { LiabilityBalanceForm } from "@web/patrimonio/[id]/editar/_surfaces/liability-balance-form";
import { BALANCE_FORM_ID } from "@web/patrimonio/action-helpers";
import { debtBalanceCurveInput } from "@worthline/db";
import type { LiabilityType } from "@worthline/domain";
import {
  debtAccrualAtDate,
  debtBalanceAtDate,
  debtServiceAtDate,
  formatDateKeyEs,
  formatMoneyMinorPrivacy,
} from "@worthline/domain";
import type { ReactNode } from "react";
import {
  DEBT_ACTION,
  DEBT_TAB,
  type DebtActionKey,
  debtFichaShape,
} from "./debt-ficha-shape";
import type {
  DebtFamilyContext,
  FichaAction,
  FichaFigure,
  FichaTab,
  HoldingSurface,
} from "./family-contract";
import { holdingSurface } from "./family-contract";

/** The instrument under the name: what the debt is, in the board's words. */
const LIABILITY_LABELS: Record<LiabilityType, string> = {
  debt: "Deuda",
  mortgage: "Hipoteca",
};

/** Each action's words in the bar and on its panel. */
const ACTION_LABELS: Record<DebtActionKey, string> = {
  anticipada: "Registrar amortización anticipada",
  modelo: "Modelo de deuda",
  recalibrar: "Recalibrar con saldo real",
  revision: "Registrar revisión de tipo",
  saldo: "Registrar saldo",
  "saldo-pendiente": "Actualizar saldo",
};

export async function loadDebtSurface(ctx: DebtFamilyContext): Promise<HoldingSurface> {
  const { currentUrl, formError, id, isDemo, liability, privacyMode, store, today } = ctx;

  // Valuation cadence (ADR 0031, #393) rides the model's wave; null reads as `step`.
  const [debtModel, valuationCadence] = await Promise.all([
    store.liabilities.readDebtModel(id),
    store.liabilities.readValuationCadence(id),
  ]);

  const [amortizationPlan, balanceRebaselines] =
    debtModel === "amortizable"
      ? await Promise.all([
          store.liabilities.readAmortizationPlan(id),
          store.liabilities.readBalanceRebaselines(id),
        ])
      : [null, []];
  const [rateRevisions, earlyRepayments] = amortizationPlan
    ? await Promise.all([
        store.liabilities.readInterestRateRevisions(amortizationPlan.id),
        store.liabilities.readEarlyRepayments(amortizationPlan.id),
      ])
    : [[], []];
  const balanceAnchors =
    debtModel === "revolving" || debtModel === "informal"
      ? await store.liabilities.readBalanceAnchors(id)
      : [];

  // The curve input, assembled ONCE from the rows read above by the same function
  // the board's read uses (#1848): the header's balance is the board row's, and the
  // accrual and the cuota beside it provably describe that one curve — at no extra
  // I/O, where `store.liabilities.debtBalanceAtDate` would re-read every row (#1292).
  const curve = debtBalanceCurveInput({
    anchors: balanceAnchors,
    balanceRebaselines,
    cadence: valuationCadence,
    currentBalanceMinor: liability.currentBalance.amountMinor,
    debtModel,
    earlyRepayments,
    plan: amortizationPlan,
    revisions: rateRevisions,
  });
  const atToday = curve ? { ...curve, targetDate: today } : null;
  const balanceMinor = atToday
    ? debtBalanceAtDate(atToday)
    : liability.currentBalance.amountMinor;
  // An amortizable debt with a plan OR a re-baseline has a schedule to walk (#678).
  const hasSchedule =
    debtModel === "amortizable" &&
    (amortizationPlan !== null || balanceRebaselines.length > 0);

  const shape = debtFichaShape({
    debtModel,
    hasAmortizationPlan: amortizationPlan !== null,
    hasBalanceAnchors: balanceAnchors.length > 0,
    hasBalanceRebaselines: balanceRebaselines.length > 0,
  });
  const fichaTabs = [...shape.tabs, FICHA_DATOS_TAB];
  const tabUrl = (tab: string) => fichaTabUrl(currentUrl, fichaTabs, tab);
  const money = (amountMinor: number) =>
    formatMoneyMinorPrivacy(
      { amountMinor, currency: liability.currentBalance.currency },
      privacyMode,
    );

  // ── The state header ────────────────────────────────────────────────────────
  const figures: FichaFigure[] = [
    {
      key: "model",
      kind: "text",
      label: "Modelo",
      value: debtModel ? (
        DEBT_MODEL_LABELS[debtModel]
      ) : (
        // Said up here, not only where the model is chosen: the board's health
        // aviso (`MISSING_DEBT_MODEL`) sends the person to this ficha for it.
        <>
          Sin modelo <span aria-hidden="true">·</span>{" "}
          <FichaLink
            action={DEBT_ACTION.model}
            href={fichaActionUrl(
              currentUrl,
              fichaTabs,
              FICHA_DATOS_TAB,
              DEBT_ACTION.model,
            )}
          >
            Elegir modelo
          </FichaLink>
        </>
      ),
    },
  ];
  if (debtModel === "amortizable") {
    const service = atToday && hasSchedule ? debtServiceAtDate(atToday) : null;
    figures.push({
      key: "cuota",
      label: "Cuota vigente",
      ...(service
        ? {
            detail: (
              <small className="priceRefreshCaption">
                próxima el {formatDateKeyEs(service.nextPaymentDate)}
              </small>
            ),
            value: formatEurCentsPrivacy(service.paymentMinor, privacyMode),
          }
        : hasSchedule
          ? { value: "—" }
          : {
              kind: "text" as const,
              value: (
                <>
                  Sin plan <span aria-hidden="true">·</span>{" "}
                  <FichaLink
                    field="csOutstandingBalance"
                    href={tabUrl(DEBT_TAB.plan)}
                    tab={DEBT_TAB.plan}
                  >
                    Configurar el plan
                  </FichaLink>
                </>
              ),
            }),
    });
  } else if (debtModel !== null) {
    const latest = [...balanceAnchors].sort((a, b) =>
      b.anchorDate.localeCompare(a.anchorDate),
    )[0];
    figures.push({
      key: "anchor",
      label: "Último saldo declarado",
      ...(latest
        ? {
            detail: (
              <small className="priceRefreshCaption">
                del {formatDateKeyEs(latest.anchorDate)}
              </small>
            ),
            value: money(latest.balanceMinor),
          }
        : { kind: "text" as const, value: "Sin saldos declarados" }),
    });
  }

  // ── The actions, each a form in the side panel ─────────────────────────────
  const panelOf: Record<DebtActionKey, () => ReactNode> = {
    anticipada: () =>
      amortizationPlan ? (
        <EarlyRepaymentForm
          currentUrl={tabUrl(DEBT_TAB.repayments)}
          formError={formError}
          liabilityId={id}
          planId={amortizationPlan.id}
          readOnly={isDemo}
          today={today}
        />
      ) : null,
    modelo: () => (
      <DebtModelForm
        currentUrl={currentUrl}
        debtModel={debtModel}
        formError={formError}
        liabilityId={id}
        readOnly={isDemo}
        valuationCadence={valuationCadence}
      />
    ),
    recalibrar: () => (
      <DebtRecalibrateForm
        // What separates the modelled capital from the settlement amount the bank
        // shows, so the panel can name WHICH magnitude is compared (#1292).
        currentDebtAccrual={atToday ? debtAccrualAtDate(atToday) : null}
        currentModelledBalanceMinor={balanceMinor}
        currentUrl={tabUrl(DEBT_TAB.plan)}
        formError={formError}
        liabilityId={id}
        privacyMode={privacyMode}
        readOnly={isDemo}
        today={today}
      />
    ),
    revision: () =>
      amortizationPlan ? (
        <RevisionForm
          currentUrl={tabUrl(DEBT_TAB.revisions)}
          formError={formError}
          liabilityId={id}
          planId={amortizationPlan.id}
          readOnly={isDemo}
          today={today}
        />
      ) : null,
    saldo: () => (
      <BalanceAnchorForm
        currentUrl={tabUrl(DEBT_TAB.anchors)}
        formError={formError}
        liabilityId={id}
        readOnly={isDemo}
        today={today}
      />
    ),
    // The new balance shows in the header, on whichever tab: the bare ficha.
    "saldo-pendiente": () => (
      <LiabilityBalanceForm
        currentUrl={currentUrl}
        formError={formError}
        liability={liability}
        placement="panel"
        readOnly={isDemo}
        returnTo={currentUrl}
      />
    ),
  };
  const actions: FichaAction[] = shape.actions.map(({ key, tier }) => ({
    content: panelOf[key](),
    key,
    // With no model yet the same panel is a choice to make, said as one.
    label:
      key === DEBT_ACTION.model && debtModel === null
        ? "Elegir modelo"
        : ACTION_LABELS[key],
    tier,
  }));

  // ── The tabs ────────────────────────────────────────────────────────────────
  const tabOf: Record<(typeof shape.tabs)[number], () => FichaTab> = {
    anticipadas: () => ({
      content: amortizationPlan ? (
        <EarlyRepaymentsTable
          currentUrl={tabUrl(DEBT_TAB.repayments)}
          formError={formError}
          liabilityId={id}
          planId={amortizationPlan.id}
          privacyMode={privacyMode}
          repayments={earlyRepayments}
          today={today}
        />
      ) : null,
      count: earlyRepayments.length,
      key: DEBT_TAB.repayments,
      label: "Anticipadas",
    }),
    plan: () => ({
      content: (
        <DebtPlanSection
          currentUrl={tabUrl(DEBT_TAB.plan)}
          formError={formError}
          liabilityId={id}
          plan={amortizationPlan}
          privacyMode={privacyMode}
          today={today}
        />
      ),
      key: DEBT_TAB.plan,
      label: "Plan",
    }),
    revisiones: () => ({
      content: amortizationPlan ? (
        <RevisionsTable
          currentUrl={tabUrl(DEBT_TAB.revisions)}
          formError={formError}
          liabilityId={id}
          planId={amortizationPlan.id}
          revisions={rateRevisions}
          today={today}
        />
      ) : null,
      count: rateRevisions.length,
      key: DEBT_TAB.revisions,
      label: "Revisiones",
    }),
    saldos: () => ({
      content: (
        <BalanceAnchorsTable
          anchors={balanceAnchors}
          currentUrl={tabUrl(DEBT_TAB.anchors)}
          formError={formError}
          liabilityId={id}
          privacyMode={privacyMode}
          today={today}
        />
      ),
      count: balanceAnchors.length,
      key: DEBT_TAB.anchors,
      label: "Saldos",
    }),
  };

  return holdingSurface("debt", {
    // «Actualizar saldo» is the bar's now (#1848): «Lo básico» keeps the identity.
    basics: { showRawBalanceForm: false },
    ficha: {
      actions,
      errorTargets: {
        // A panel form's refusal reopens its panel, over the tab its result shows on.
        [BALANCE_FORM_ID]: { action: DEBT_ACTION.balance },
        [DEBT_FORM_ID.anchor]: { action: DEBT_ACTION.anchor },
        [DEBT_FORM_ID.cadence]: { action: DEBT_ACTION.model },
        [DEBT_FORM_ID.model]: { action: DEBT_ACTION.model },
        [DEBT_FORM_ID.recalibrate]: { action: DEBT_ACTION.recalibrate },
        [DEBT_FORM_ID.repayment]: {
          action: DEBT_ACTION.repayment,
          tab: DEBT_TAB.repayments,
        },
        [DEBT_FORM_ID.revision]: {
          action: DEBT_ACTION.revision,
          tab: DEBT_TAB.revisions,
        },
        // A tab's own forms: the tab, where the band above it says why.
        [DEBT_FORM_ID.plan]: { tab: DEBT_TAB.plan },
        [DEBT_FORM_ID.currentState]: { tab: DEBT_TAB.plan },
        ...Object.fromEntries([
          ...rateRevisions.map((row) => [
            rowFormId(DEBT_FORM_ID.revision, row.id),
            { tab: DEBT_TAB.revisions },
          ]),
          ...earlyRepayments.map((row) => [
            rowFormId(DEBT_FORM_ID.repayment, row.id),
            { tab: DEBT_TAB.repayments },
          ]),
          ...balanceAnchors.map((row) => [
            rowFormId(DEBT_FORM_ID.anchor, row.id),
            { tab: DEBT_TAB.anchors },
          ]),
        ]),
      },
      figures,
      instrument: LIABILITY_LABELS[liability.type],
      ownErrorForms: [...DEBT_PANEL_FORM_IDS, BALANCE_FORM_ID],
      // What each tab lists, so the row a terminal adds is pointed at (#1829).
      rows: amortizationPlan
        ? {
            [REPAYMENTS_ROW_LIST]: earlyRepayments.map((row) => row.id),
            [REVISIONS_ROW_LIST]: rateRevisions.map((row) => row.id),
          }
        : shape.tabs.includes(DEBT_TAB.anchors)
          ? { [ANCHORS_ROW_LIST]: balanceAnchors.map((row) => row.id) }
          : {},
      tabs: shape.tabs.map((tab) => tabOf[tab]()),
      // A debt is a pasivo: «− X €», in ink like the board's row — never `.neg`,
      // which is for a movement, not a balance (canon §6).
      value: `− ${money(balanceMinor)}`,
      // No warning of the band is about a liability's own row.
      warnings: [],
    },
  });
}

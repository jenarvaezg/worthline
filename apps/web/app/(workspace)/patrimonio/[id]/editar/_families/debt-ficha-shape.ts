/**
 * Which actions a debt's bar offers and which tabs its ficha has, by model (#1848).
 *
 * The rule of #1737 applied to a debt: frequency decides what is in view, nature
 * decides where the rest goes. What is done often to a mortgage is recording what
 * happened to it — an early repayment, a rate revision —, to a card or a loan
 * between relatives it is declaring what is owed today, and to a debt with no model
 * it is choosing one. Each action is offered only where its form is offered today:
 * a revision and an early repayment hang off a plan (#446), «Recalibrar» needs a
 * curve to recalibrate (#678), and «Actualizar saldo» writes the stored balance, so
 * it is offered exactly while that balance is still the debt's figure
 * (`storedBalanceGovernsDebtFigure`, #1290) — anywhere else it is a write into the
 * void.
 *
 * Pure (interaction-patterns §7): the loader renders what this says; the table is
 * the test.
 */

import type { DebtModel } from "@worthline/domain";
import { storedBalanceGovernsDebtFigure } from "@worthline/domain";
import type { FichaActionTier } from "./family-contract";

/** The debt ficha's actions, by their `?accion=`. */
export const DEBT_ACTION = {
  /** «Registrar saldo»: a declared balance of a revolving or informal debt. */
  anchor: "saldo",
  /** «Actualizar saldo»: the stored `current_balance_minor` (#1290). */
  balance: "saldo-pendiente",
  /** «Modelo de deuda»: the model, and the cadence where it applies. */
  model: "modelo",
  /** «Recalibrar con saldo real» (ADR 0056). */
  recalibrate: "recalibrar",
  /** «Registrar amortización anticipada» (PRD #146). */
  repayment: "anticipada",
  /** «Registrar revisión de tipo». */
  revision: "revision",
} as const;

export type DebtActionKey = (typeof DEBT_ACTION)[keyof typeof DEBT_ACTION];

/** The debt ficha's own tabs, by their `?pestaña=`; the page appends «Datos». */
export const DEBT_TAB = {
  anchors: "saldos",
  plan: "plan",
  repayments: "anticipadas",
  revisions: "revisiones",
} as const;

export type DebtTabKey = (typeof DEBT_TAB)[keyof typeof DEBT_TAB];

export interface DebtFichaShape {
  /** In bar order; the first `primary` is the habitual one. */
  actions: { key: DebtActionKey; tier: FichaActionTier }[];
  /** In order; the first opens by default. */
  tabs: DebtTabKey[];
}

export function debtFichaShape(rows: {
  debtModel: DebtModel | null;
  hasAmortizationPlan: boolean;
  hasBalanceRebaselines: boolean;
  hasBalanceAnchors: boolean;
}): DebtFichaShape {
  const storedGoverns = storedBalanceGovernsDebtFigure(rows);
  const { debtModel, hasAmortizationPlan, hasBalanceRebaselines } = rows;

  if (debtModel === null) {
    return {
      actions: [
        { key: DEBT_ACTION.model, tier: "primary" },
        { key: DEBT_ACTION.balance, tier: "secondary" },
      ],
      tabs: [],
    };
  }

  if (debtModel === "amortizable") {
    const hasCurve = hasAmortizationPlan || hasBalanceRebaselines;
    const model = { key: DEBT_ACTION.model, tier: "more" } as const;
    if (hasAmortizationPlan) {
      return {
        actions: [
          { key: DEBT_ACTION.repayment, tier: "primary" },
          { key: DEBT_ACTION.revision, tier: "secondary" },
          { key: DEBT_ACTION.recalibrate, tier: "secondary" },
          model,
        ],
        tabs: [DEBT_TAB.plan, DEBT_TAB.revisions, DEBT_TAB.repayments],
      };
    }
    return {
      actions: [
        hasCurve
          ? { key: DEBT_ACTION.recalibrate, tier: "primary" }
          : { key: DEBT_ACTION.balance, tier: "primary" },
        model,
      ],
      tabs: [DEBT_TAB.plan],
    };
  }

  return {
    actions: [
      { key: DEBT_ACTION.anchor, tier: "primary" },
      ...(storedGoverns ? [{ key: DEBT_ACTION.balance, tier: "more" } as const] : []),
      { key: DEBT_ACTION.model, tier: "more" },
    ],
    tabs: [DEBT_TAB.anchors],
  };
}

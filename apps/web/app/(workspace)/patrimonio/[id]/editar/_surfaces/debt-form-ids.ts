/**
 * The debt ficha's form ids (#1848) — what each server action names its refusal
 * with, so the ficha can reopen the panel or show the tab that holds the form. A
 * panel form prints its own refusal with the shared `FormRefusal`
 * (`@web/_components/form-refusal`).
 *
 * The ids are the ones the actions always used (`debt-actions`, `balance-anchor-
 * actions`, `valuation-actions`); they are named here, beside the forms, instead of
 * being spelled again in the family's targets and in the page's list.
 */

export const DEBT_FORM_ID = {
  /** «Registrar saldo» (revolving / informal). */
  anchor: "balanceAnchor",
  /** «Cadencia de valoración» (ADR 0031). */
  cadence: "cadence",
  /** «Alta por estado actual» (ADR 0056). */
  currentState: "currentStateDebt",
  /** «Modelo de deuda». */
  model: "debtModel",
  /** The amortization plan, created or edited. */
  plan: "plan",
  /** «Recalibrar con saldo real». */
  recalibrate: "recalibrateDebt",
  /** «Registrar amortización anticipada». */
  repayment: "repayment",
  /** «Registrar revisión de tipo». */
  revision: "revision",
} as const;

/** A row's inline edit: `revision-<id>`, `repayment-<id>`, `balanceAnchor-<id>`. */
export function rowFormId(
  form:
    | typeof DEBT_FORM_ID.revision
    | typeof DEBT_FORM_ID.repayment
    | typeof DEBT_FORM_ID.anchor,
  rowId: string,
): string {
  return `${form}-${rowId}`;
}

/**
 * The forms that live in the debt ficha's side panel: each prints its own refusal,
 * so the page's band leaves them out (on a phone the panel covers that band).
 */
export const DEBT_PANEL_FORM_IDS: readonly string[] = [
  DEBT_FORM_ID.anchor,
  DEBT_FORM_ID.cadence,
  DEBT_FORM_ID.model,
  DEBT_FORM_ID.recalibrate,
  DEBT_FORM_ID.repayment,
  DEBT_FORM_ID.revision,
];

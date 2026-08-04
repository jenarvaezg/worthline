import type { MaintainerAlertPayload } from "./maintainer-alert";

/**
 * The admission control of the maintainer alert (#1347), a boundary in CODE and
 * not one more prompt sentence (#1326).
 *
 * The failure it closes, from a real transcript (2026-07-30): a user asked for an
 * ISIN to be set on a fund. `propose_correction` has no ISIN field, so the attempt
 * failed — and the model, cornered, reached for `raise_maintainer_alert` and wrote
 * the user's WISH into it as an `infidelity` alert («el usuario desea asignar el
 * ISIN LU… pero la herramienta no permite…»), then promised the user that «nuestro
 * equipo lo revisará». Three lies at once: the category means painted ≠ recomputed
 * (ADR 0064, #1050), there is no support team behind the alert (it is the
 * maintainer's own /admin panel), and the ISIN was already registered.
 *
 * So the question this module asks is the one that makes the three categories
 * true: does the payload carry something a maintainer could actually diagnose?
 * Three admissible forms, and the summary's prose is none of them:
 *  - the TRACE's own verdict — a persisted point the current config no longer
 *    reproduces, a diverging reconciliation row, or a declared residual outside
 *    the documented band;
 *  - the TWO CONFLICTING FIGURES — the user's declared balance against the
 *    painted one, both assembled deterministically by the tool. Figures that
 *    AGREE are refused: the trace exists only for modelled debts, so without this
 *    an alert about a fund needed nothing but any number at all to pass;
 *  - for `sync_source` only, the SOURCE ITSELF — the smell of that category is a
 *    connected-source ownership problem rather than a magnitude (ADR 0064), and a
 *    source that has not synced in weeks has no figure to declare. The holding
 *    must actually be materialized by a source, which is exactly what the
 *    2026-07-30 fund was not.
 *
 * Everything is pure and payload-shaped, so the invariant is testable in CI
 * without API keys — unlike the prompt sentence it replaces.
 */

/** Why an alert was refused. `null` when the payload carries something diagnosable. */
export type MaintainerAlertRefusal =
  | "maintainer_alert_without_discrepancy"
  | "maintainer_alert_figures_agree";

/**
 * The alert had nothing to diagnose. The message ROUTES rather than just blocking
 * (the lesson of #1248): it names what the channel is for, kills the «support
 * team» fiction out loud — the promise, not just the alert, is what reached the
 * user — and points at the two surfaces that own what an alert cannot fix. It
 * names them as the places to LOOK, not as the answer: which one applies depends
 * on what the user asked for, and inventing a confident wrong surface would be
 * the very failure of #1347 in a new costume.
 */
export const MAINTAINER_ALERT_WITHOUT_DISCREPANCY_MESSAGE =
  "Esta alerta solo sirve para un descuadre de CIFRAS de worthline (un saldo pintado " +
  "que el motor ya no reproduce, un residuo por encima de la tolerancia, una fuente " +
  "conectada que no cuadra), y este intento no trae ninguno. No es un canal de " +
  "soporte: detrás no hay ningún equipo que revise ni tramite nada, así que no le " +
  "prometas al usuario gestión alguna. Dile con claridad qué no puedes hacer tú y, si " +
  "el producto sí lo hace en alguna parte, dónde: los datos de una posición (nombre, " +
  "ISIN, símbolo) se editan en su ficha, en /patrimonio abriendo la posición; una " +
  "fuente conectada se gobierna en /ajustes/conexiones.";

/**
 * The two figures agree, so there is no discrepancy to raise. Refusing here matters
 * as much as the empty case: an alert whose own payload shows the same number twice
 * would land on /admin as a bug that is not one.
 */
export const MAINTAINER_ALERT_FIGURES_AGREE_MESSAGE =
  "No hay descuadre que levantar: la cifra que declara el usuario y la que calcula " +
  "worthline coinciden (o su diferencia cae dentro de la banda de tolerancia), así " +
  "que no hay bug que diagnosticar. Explícaselo con las dos cifras y su fecha, y no " +
  "le prometas que nadie va a revisarlo: detrás de esta alerta no hay ningún equipo " +
  "de soporte.";

/** The typed envelope the model relays, sibling of the unvalidated-evidence one. */
export interface MaintainerAlertRefusedError {
  error: MaintainerAlertRefusal;
  message: string;
}

const REFUSAL_MESSAGES: Record<MaintainerAlertRefusal, string> = {
  maintainer_alert_without_discrepancy: MAINTAINER_ALERT_WITHOUT_DISCREPANCY_MESSAGE,
  maintainer_alert_figures_agree: MAINTAINER_ALERT_FIGURES_AGREE_MESSAGE,
};

export function maintainerAlertRefused(
  refusal: MaintainerAlertRefusal,
): MaintainerAlertRefusedError {
  return { error: refusal, message: REFUSAL_MESSAGES[refusal] };
}

/**
 * Does the trace itself see a mismatch? `fidelity.faithful` and the diverging
 * reconciliation rows are two readings of the same comparison (the contract
 * derives one from the other), kept both because a trace may carry divergences it
 * did not fold into the verdict; the tolerance check is the independent one — it
 * is about the user's figure, not about persistence.
 */
function traceShowsDiscrepancy(payload: MaintainerAlertPayload): boolean {
  const trace = payload.calculationTrace;
  if (!trace) return false;
  return (
    !trace.fidelity.faithful ||
    trace.reconciliation.some((point) => point.diverges) ||
    trace.tolerance.declared?.withinTolerance === false
  );
}

/**
 * Do the declared and the painted figure actually differ? Compared in raw minor
 * units and only when the currency matches — a declared figure in another currency
 * is not «the same number twice», it is a conversion question worth a look.
 */
function declaredFigureConflicts(payload: MaintainerAlertPayload): boolean {
  const declared = payload.declared;
  if (declared === undefined) return false;
  const painted = payload.holding?.currentValue;
  if (!painted || painted.currency !== declared.currency) return true;
  return painted.amountMinor !== declared.balanceMinor;
}

/**
 * A `sync_source` alert over a holding a connected source actually owns. The
 * category's own definition (ADR 0064) is «the smell is a connected-source/sync
 * ownership problem, not a calc bug», and those smells — a source stuck for weeks,
 * a sync that returned nothing — have no magnitude to declare. Narrow on purpose:
 * a manual holding has no `source`, so the 2026-07-30 fund does not get in through
 * here by relabelling the category.
 */
function sourceIsDiagnosable(payload: MaintainerAlertPayload): boolean {
  return payload.category === "sync_source" && payload.holding?.source !== undefined;
}

/**
 * The admission verdict: `null` lets the alert through, a refusal stops it before
 * the control-plane write. Ordered so the engine's own verdict always wins — a
 * declared figure that agrees with the painted one cannot mask a real infidelity,
 * and an engine that saw no mismatch is not overridden by prose in the summary.
 */
export function maintainerAlertRefusalFor(
  payload: MaintainerAlertPayload,
): MaintainerAlertRefusal | null {
  if (traceShowsDiscrepancy(payload)) return null;
  if (sourceIsDiagnosable(payload)) return null;
  if (payload.declared === undefined) return "maintainer_alert_without_discrepancy";
  if (payload.calculationTrace?.tolerance.declared?.withinTolerance === true) {
    return "maintainer_alert_figures_agree";
  }
  // No trace to adjudicate the figure (it exists only for modelled debts): the
  // painted figure in the snapshot is the counterpart, and /admin does the
  // arithmetic. Equal figures are not a descuadre, whatever the summary claims.
  return declaredFigureConflicts(payload) ? null : "maintainer_alert_figures_agree";
}

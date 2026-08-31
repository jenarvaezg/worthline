/**
 * Lo que el usuario está tecleando en el formulario de supuestos, como números
 * (#1450).
 *
 * Entre el `<input>` y el motor hay una traducción que no puede vivir dentro de un
 * componente: un campo a medio escribir («3,» mientras teclea «3,5»), un campo
 * vaciado para reescribirlo, una coma decimal española. La regla es una sola y
 * vale para los cuatro campos: **lo ilegible no borra lo guardado**. Si el borrador
 * no dice un número, el motor sigue viendo el valor con el que se cargó la página,
 * y las cifras de la derecha no parpadean a cero mientras el usuario escribe.
 *
 * Pura por `interaction-patterns.md` §7: la isla solo llama, aquí se decide.
 */

import type { FireAssumptionOverrides } from "@worthline/domain";

/** Los campos editables de la cara visible, tal cual viajan en el estado de la isla. */
export interface FireAssumptionDraft {
  monthlySpending: string;
  safeWithdrawalRate: string;
  monthlySavingsCapacity: string;
  targetRetirementAge: string;
  /**
   * La declaración sobre el inmovilizado (#1473). Booleano y no texto: una casilla no
   * tiene estado ilegible, así que aquí no hay «lo ilegible no borra lo guardado» que
   * aplicar — siempre dice sí o no, y el motor elige lado con eso.
   */
  countImmobilized: boolean;
  /**
   * ¿El gasto declarado incluye el servicio de deuda? (#1520.) `""` = sin declarar.
   *
   * Está en el borrador aunque **no sea un override del motor**: no mueve ninguna
   * cifra, pero sí mueve la glosa de la tarjeta de gasto sostenible, y está en la cara
   * visible del formulario. La regla de #1473 es que lo que se ve responde al tocarlo;
   * un `select` ahí que no moviera nada se leería como que la app lo ignora.
   */
  spendingIncludesDebtService: string;
}

/**
 * Los campos del borrador que se teclean, sin el check (#1473). Existe para que un
 * `onChange` de texto no pueda apuntar a la casilla: el genérico sobre
 * `keyof FireAssumptionDraft` compilaba escribiendo un string donde vive un booleano.
 */
export type FireAssumptionTextField = Exclude<
  keyof FireAssumptionDraft,
  "countImmobilized"
>;

/**
 * La declaración del servicio de deuda que el borrador dice, en el tri-estado que el
 * dominio entiende (#1520). Un valor que no reconocemos se lee como «sin declarar», la
 * misma lectura que hace el parser del guardado — así la previsualización y lo que se
 * escribe no pueden discrepar.
 */
export function draftSpendingIncludesDebtService(
  draft: FireAssumptionDraft,
): boolean | undefined {
  const declared = draft.spendingIncludesDebtService;
  return declared === "yes" ? true : declared === "no" ? false : undefined;
}

/** Un número es-ES (coma o punto) o null si el texto no lo dice. */
function parseNumber(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (normalized === "") {
    return null;
  }
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * El borrador convertido en overrides del motor. Un campo sin número legible
 * queda fuera, y `previewFireWithAssumptions` conserva entonces lo guardado.
 */
export function fireAssumptionOverrides(
  draft: FireAssumptionDraft,
): FireAssumptionOverrides {
  const spending = parseNumber(draft.monthlySpending);
  const rate = parseNumber(draft.safeWithdrawalRate);
  const savings = parseNumber(draft.monthlySavingsCapacity);
  const targetAge = parseNumber(draft.targetRetirementAge);

  return {
    // La declaración del ladrillo (#1473): no la traduce nadie, elige lado del par que
    // el servidor precalculó.
    immobilizedCountsAsFireCapital: draft.countImmobilized,
    // Un gasto de 0 daría un número FIRE de 0 y un «100 % financiado» falso; el
    // formulario ya lo rechaza al guardar, así que la vista tampoco lo previsualiza.
    ...(spending !== null && spending > 0
      ? { monthlySpendingMinor: Math.round(spending * 100) }
      : {}),
    // Una tasa de 0 dividiría por cero.
    ...(rate !== null && rate > 0 ? { safeWithdrawalRate: rate / 100 } : {}),
    // Cero SÍ es una declaración válida: «ahora mismo no ahorro» (ADR 0074).
    ...(savings !== null && savings >= 0
      ? { monthlySavingsCapacityMinor: Math.round(savings * 100) }
      : {}),
    ...(targetAge !== null && targetAge > 0
      ? { targetRetirementAge: Math.round(targetAge) }
      : {}),
  };
}

/**
 * ¿El borrador dice algo distinto de lo guardado? Gobierna el aviso de «sin
 * guardar»: sin él, unas cifras previsualizadas se leerían como cifras firmes.
 */
export function isFireAssumptionDraftDirty(
  draft: FireAssumptionDraft,
  saved: FireAssumptionDraft,
): boolean {
  return (
    draft.countImmobilized !== saved.countImmobilized ||
    draft.monthlySpending !== saved.monthlySpending ||
    draft.safeWithdrawalRate !== saved.safeWithdrawalRate ||
    draft.monthlySavingsCapacity !== saved.monthlySavingsCapacity ||
    draft.targetRetirementAge !== saved.targetRetirementAge ||
    draft.spendingIncludesDebtService !== saved.spendingIncludesDebtService
  );
}

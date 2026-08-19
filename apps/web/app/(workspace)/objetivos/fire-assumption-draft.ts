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

/** Los cuatro campos editables, tal cual viajan en el estado de la isla. */
export interface FireAssumptionDraft {
  monthlySpending: string;
  safeWithdrawalRate: string;
  monthlySavingsCapacity: string;
  targetRetirementAge: string;
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
    draft.monthlySpending !== saved.monthlySpending ||
    draft.safeWithdrawalRate !== saved.safeWithdrawalRate ||
    draft.monthlySavingsCapacity !== saved.monthlySavingsCapacity ||
    draft.targetRetirementAge !== saved.targetRetirementAge
  );
}

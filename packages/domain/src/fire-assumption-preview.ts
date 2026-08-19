/**
 * Recalcular el FIRE con unos supuestos que el usuario está tecleando (#1450).
 *
 * El formulario de supuestos vive al lado de las cifras que gobierna, y «editas
 * aquí, ves ahí» solo es cierto si las cifras se mueven al teclear. Lo que NO
 * puede pasar es que la pantalla nazca con dos aritméticas: una en el servidor y
 * otra, reescrita, en el cliente.
 *
 * De ahí esta puerta. Reparte el cálculo por lo que cada mitad depende:
 *
 * - **Lo que los supuestos NO mueven** — qué activos son elegibles, cuánto suman,
 *   cómo se parten en vendible e inmovilizado, la ponderación de la que sale la
 *   tasa y lo reservado para metas — se calculó en el servidor y se conserva tal
 *   cual. Teclear un gasto distinto no cambia lo que tienes.
 * - **Lo que sí mueven** — número FIRE, % financiado, Coast y sus edades — se
 *   recalcula con `calculateFire`, la MISMA función que produjo el baseline.
 *
 * Así la previsualización no es una segunda implementación de las fórmulas: es la
 * primera, con otros insumos. La proyección, el rail de niveles y el tick de Coast
 * salen después del `context` que esto devuelve, por sus puertas de siempre.
 */

import type { FireScopeConfig } from "./fire";
import { calculateFire, type FireContext, type ScopeFireResult } from "./fire";

/** Los cuatro escalares que el formulario deja editar en su cara visible. */
export interface FireAssumptionOverrides {
  monthlySpendingMinor?: number;
  safeWithdrawalRate?: number;
  monthlySavingsCapacityMinor?: number;
  targetRetirementAge?: number;
}

/**
 * `baseline` con los supuestos sustituidos. Un override `undefined` no pisa nada:
 * un campo que el usuario no ha tocado sigue valiendo lo guardado.
 */
export function previewFireWithAssumptions(
  baseline: ScopeFireResult,
  overrides: FireAssumptionOverrides,
): ScopeFireResult {
  const config: FireScopeConfig = {
    ...baseline.context.config,
    ...(overrides.monthlySpendingMinor === undefined
      ? {}
      : { monthlySpendingMinor: overrides.monthlySpendingMinor }),
    ...(overrides.safeWithdrawalRate === undefined
      ? {}
      : { safeWithdrawalRate: overrides.safeWithdrawalRate }),
    ...(overrides.monthlySavingsCapacityMinor === undefined
      ? {}
      : { monthlySavingsCapacityMinor: overrides.monthlySavingsCapacityMinor }),
    ...(overrides.targetRetirementAge === undefined
      ? {}
      : { targetRetirementAge: overrides.targetRetirementAge }),
  };

  // La tasa y el capital son los del baseline: el pool no se re-ensambla porque
  // ningún supuesto de este formulario lo toca (la tasa manual y los retornos por
  // tramo sí lo harían, y por eso NO están entre los overrides — al cambiarlos hay
  // que guardar para verlos).
  const recomputed = calculateFire(
    config,
    baseline.context.eligibleMinor,
    baseline.context.currency,
    baseline.context.realReturnUsed,
  );

  const context: FireContext = {
    ...baseline.context,
    config,
    fireNumberMinor: recomputed.fireNumber.amountMinor,
  };

  // Construido campo a campo y no con `{...baseline, ...recomputed}`: los campos de
  // Coast son opcionales, así que un baseline CON Coast y un recálculo SIN él (al
  // borrar la edad objetivo) dejarían el Coast viejo en pie bajo un número nuevo.
  return {
    capitalSplit: baseline.capitalSplit,
    context,
    eligibleAssets: recomputed.eligibleAssets,
    excludedAssets: baseline.excludedAssets,
    fireNumber: recomputed.fireNumber,
    percentFunded: recomputed.percentFunded,
    rentReturns: baseline.rentReturns,
    returnMix: baseline.returnMix,
    ...(recomputed.coastFireRequired === undefined
      ? {}
      : { coastFireRequired: recomputed.coastFireRequired }),
    ...(recomputed.coastFireAge === undefined
      ? {}
      : { coastFireAge: recomputed.coastFireAge }),
    ...(recomputed.isAlreadyAtCoastFire === undefined
      ? {}
      : { isAlreadyAtCoastFire: recomputed.isAlreadyAtCoastFire }),
    ...(baseline.reservedForGoals === undefined
      ? {}
      : { reservedForGoals: baseline.reservedForGoals }),
  };
}

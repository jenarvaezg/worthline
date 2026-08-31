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
 * - **Lo que cambia de lado** — la declaración sobre el inmovilizado (#1473) — SÍ
 *   mueve capital y tasa, así que no se recalcula: el servidor manda los dos lados
 *   ya calculados y aquí solo se elige uno. La frontera de lo que responde en vivo
 *   no es «toca el pool o no», es «está a la vista o no»: lo que el usuario ve
 *   entre campos vivos tiene que responder como ellos.
 *
 * Así la previsualización no es una segunda implementación de las fórmulas: es la
 * primera, con otros insumos. La proyección, el rail de niveles y el tick de Coast
 * salen después del `context` que esto devuelve, por sus puertas de siempre.
 */

import type { FireScopeConfig } from "./fire";
import {
  calculateFire,
  type FireContext,
  fireCountsImmobilizedCapital,
  type ScopeFireResult,
} from "./fire";

/** Lo que el formulario deja editar en su cara visible. */
export interface FireAssumptionOverrides {
  monthlySpendingMinor?: number;
  safeWithdrawalRate?: number;
  monthlySavingsCapacityMinor?: number;
  targetRetirementAge?: number;
  /**
   * La declaración sobre el ladrillo (#1473). No es un escalar como los otros cuatro:
   * cambiarla mueve el capital elegible Y la tasa ponderada, así que no se puede
   * recalcular aquí sin escribir una segunda aritmética. Es un **selector de lado**
   * — el llamador precalcula el par en el servidor y esta puerta elige — y por eso
   * NO se copia al `config` del resultado: el config sale del lado elegido, que ya
   * lo declara.
   */
  immobilizedCountsAsFireCapital?: boolean;
}

/**
 * El lado del par que la declaración pide (#1473). Se elige leyendo lo que cada
 * lado DECLARA, no por el orden en que llegaron: así un llamador que pase el par al
 * revés obtiene lo correcto, y uno que no pase contrafactual ninguno se queda con su
 * baseline entero — capital, tasa y declaración del mismo lado — en vez de con una
 * mezcla que ninguna aritmética produjo.
 */
function sideDeclaring(
  baseline: ScopeFireResult,
  counterfactual: ScopeFireResult | null | undefined,
  wanted: boolean | undefined,
): ScopeFireResult {
  if (wanted === undefined) {
    return baseline;
  }
  if (fireCountsImmobilizedCapital(baseline.context.config) === wanted) {
    return baseline;
  }
  if (
    counterfactual &&
    fireCountsImmobilizedCapital(counterfactual.context.config) === wanted
  ) {
    return counterfactual;
  }
  return baseline;
}

/**
 * `baseline` con los supuestos sustituidos. Un override `undefined` no pisa nada:
 * un campo que el usuario no ha tocado sigue valiendo lo guardado.
 */
export function previewFireWithAssumptions(
  baseline: ScopeFireResult,
  overrides: FireAssumptionOverrides,
  /**
   * El MISMO ámbito calculado con la declaración del inmovilizado invertida (#1473),
   * producido por `calculateFireForScope` en el servidor. Sin él, el override de la
   * declaración no tiene lado al que ir y se conserva el baseline.
   */
  counterfactual?: ScopeFireResult | null,
): ScopeFireResult {
  // Qué lado del par estamos previsualizando se decide ANTES de los escalares: el
  // capital, la tasa, el split y la mezcla son suyos, y los escalares se aplican
  // encima de ellos.
  const side = sideDeclaring(
    baseline,
    counterfactual,
    overrides.immobilizedCountsAsFireCapital,
  );

  const config: FireScopeConfig = {
    ...side.context.config,
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

  // La tasa y el capital son los del lado elegido: el pool no se re-ensambla aquí
  // porque ningún escalar de este formulario lo toca, y lo único que sí lo tocaba —la
  // declaración del inmovilizado— llega ya calculado por el motor (#1473). La tasa
  // manual y los retornos por tramo siguen siendo guardar-para-ver: viven plegados en
  // la letra pequeña, no en la cara visible del formulario.
  const recomputed = calculateFire(
    config,
    side.context.eligibleMinor,
    side.context.currency,
    side.context.realReturnUsed,
  );

  const context: FireContext = {
    ...side.context,
    config,
    fireNumberMinor: recomputed.fireNumber.amountMinor,
  };

  // Construido campo a campo y no con `{...baseline, ...recomputed}`: los campos de
  // Coast son opcionales, así que un baseline CON Coast y un recálculo SIN él (al
  // borrar la edad objetivo) dejarían el Coast viejo en pie bajo un número nuevo.
  return {
    // Del MISMO lado del que salen el split y la tasa (#1473): la disponibilidad se
    // resolvió contra el vendible de ese lado, así que traerla del otro imprimiría un
    // bloqueo topado a un capital que la tarjeta no está enseñando.
    availability: side.availability,
    capitalSplit: side.capitalSplit,
    context,
    eligibleAssets: recomputed.eligibleAssets,
    excludedAssets: side.excludedAssets,
    fireNumber: recomputed.fireNumber,
    percentFunded: recomputed.percentFunded,
    rentReturns: side.rentReturns,
    returnMix: side.returnMix,
    ...(recomputed.coastFireRequired === undefined
      ? {}
      : { coastFireRequired: recomputed.coastFireRequired }),
    ...(recomputed.fireAgeIfContributionsStop === undefined
      ? {}
      : { fireAgeIfContributionsStop: recomputed.fireAgeIfContributionsStop }),
    ...(recomputed.isAlreadyAtCoastFire === undefined
      ? {}
      : { isAlreadyAtCoastFire: recomputed.isAlreadyAtCoastFire }),
    ...(side.reservedForGoals === undefined
      ? {}
      : { reservedForGoals: side.reservedForGoals }),
  };
}

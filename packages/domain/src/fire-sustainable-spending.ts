/**
 * «¿Cuánto puedo gastar sin mermar mi patrimonio?» (#1428, ADR 0081).
 *
 * La inversa de la fórmula FIRE, con los mismos insumos y sin motor nuevo: si el
 * número FIRE es `gasto × 12 ÷ tasa`, el gasto sostenible es `capital × tasa`. Es la
 * pregunta que de verdad tiene quien no va a hacer FIRE — a quien decirle «te falta el
 * 31,5 %» no le sirve de nada.
 *
 * Tres decisiones la hacen honesta:
 *
 * 1. **Solo el capital vendible.** Una tasa de retirada supone una cartera que se
 *    vende a trozos y se rebalancea (#1447): un piso no es eso. Calcular el gasto
 *    sostenible sobre el pool entero heredaría exactamente la ilusión de liquidez que
 *    este ticket vino a evitar, así que el ladrillo no entra ni cuando el usuario lo
 *    cuenta como capital FIRE (#1460) — su rendimiento entra por la otra mitad.
 * 2. **Las rentas, aparte.** Para un perfil con alquileres el gasto sostenible honesto
 *    no es solo `vendible × tasa`: son **las rentas netas más lo que el capital
 *    vendible soporta**, con las dos partes dichas por separado. Es la única forma de
 *    responder sin volver a mezclar el ladrillo con lo que produce. La renta neta la
 *    decide #1448 (neto o nada, ADR 0076) y viaja ya escalada a la participación del
 *    ámbito, así que aquí no se vuelve a ponderar nada.
 * 3. **Dos versiones, no una.** «Sin tocar el principal» (perpetua) y «agotándolo a
 *    los N» (de agotamiento). La segunda es la pregunta honesta de un perfil de
 *    jubilación ordinaria —ese perfil no necesita preservar el principal a
 *    perpetuidad— y necesita una edad final, que es un dato del usuario sin defecto
 *    aplicado: sin él solo se enseña la perpetua. El motor FIRE es SWR puro y no
 *    conoce la esperanza de vida (la duración viaja dentro de la elección de la tasa);
 *    inventarla aquí sería meter una tabla actuarial en el modelo.
 *
 * Las dos versiones se calculan sobre el capital de HOY, el mismo del que sale el
 * porcentaje financiado de al lado: empezar el horizonte en una jubilación futura
 * mientras se anualiza el capital de hoy mezclaría dos relojes en la misma tarjeta.
 *
 * Puro: divide y anualiza lo que `calculateFireForScope` ya resolvió. No re-ensambla
 * el pool, no proyecta y no toca el número FIRE.
 */

import type { ScopeFireResult } from "./fire";

/** Una mitad del gasto sostenible: al año y al mes, la misma cifra. */
export interface FireSustainableSpendingPart {
  annualMinor: number;
  monthlyMinor: number;
}

/** Las dos mitades sumadas: lo que rinde el capital y lo que rinden las rentas. */
export interface FireSustainableSpendingSides {
  /** Lo que el capital vendible soporta. */
  capital: FireSustainableSpendingPart;
  /** `capital` + las rentas netas, cuando hay. */
  total: FireSustainableSpendingPart;
}

export interface FireSustainableSpendingDepletion extends FireSustainableSpendingSides {
  /** La edad a la que el capital se acaba — la declarada por el usuario. */
  untilAge: number;
  /** Los años que tiene que durar, desde la edad de referencia de hoy. */
  years: number;
}

export interface FireSustainableSpending {
  /** Las rentas netas declaradas del ámbito, o `null` si no hay ninguna. */
  rents: FireSustainableSpendingPart | null;
  /** Sin tocar el principal: `vendible × tasa de retirada`, para siempre. */
  perpetual: FireSustainableSpendingSides;
  /** Agotando el capital a la edad final declarada. `null` sin ese dato. */
  depletion: FireSustainableSpendingDepletion | null;
  /** El capital vendible del que sale la mitad de capital, neto de deuda y reserva. */
  sellableMinor: number;
  /** La tasa con la que se calculó la versión perpetua. */
  withdrawalRate: number;
  /** El retorno real con el que se anualizó la versión de agotamiento. */
  realReturnUsed: number;
}

/** Lo que la tarjeta necesita del resultado FIRE — nada que ella pueda recalcular. */
export type FireSustainableSpendingInput = Pick<
  ScopeFireResult,
  "capitalSplit" | "context" | "rentReturns"
>;

/**
 * `null` cuando no hay tasa de retirada con la que dividir: sin ella no hay ni número
 * FIRE ni gasto sostenible, y la pantalla esconde las dos cifras a la vez.
 */
export function fireSustainableSpending(
  input: FireSustainableSpendingInput,
): FireSustainableSpending | null {
  const { capitalSplit, context, rentReturns } = input;
  const { config, realReturnUsed } = context;
  const withdrawalRate = config.safeWithdrawalRate;

  if (!withdrawalRate || withdrawalRate <= 0) {
    return null;
  }

  // Lo vendible, neto de su deuda y de la reserva por metas: la misma cifra que la
  // fila «vendible» impresa en pantalla (#1447), no una segunda lectura del pool.
  const sellableMinor = capitalSplit.sellable.amountMinor;
  const rentAnnualMinor = rentReturns.netRentAnnualMinor;
  const rents = rentAnnualMinor === 0 ? null : partOf(rentAnnualMinor);

  const perpetual = sidesOf(Math.round(sellableMinor * withdrawalRate), rentAnnualMinor);

  const currentAge = config.currentAge;
  const untilAge = config.lifeExpectancyAge;
  const years =
    currentAge === undefined || untilAge === undefined ? 0 : untilAge - currentAge;
  const depletion =
    years > 0 && untilAge !== undefined
      ? {
          ...sidesOf(
            annuityAnnualMinor(sellableMinor, realReturnUsed, years),
            rentAnnualMinor,
          ),
          untilAge,
          years,
        }
      : null;

  return {
    depletion,
    perpetual,
    realReturnUsed,
    rents,
    sellableMinor,
    withdrawalRate,
  };
}

function partOf(annualMinor: number): FireSustainableSpendingPart {
  // Del anual, no al revés: el mes es una presentación del año, así que doce meses
  // pueden no sumar el año exacto — y la cifra que manda es la que la fórmula produjo.
  return { annualMinor, monthlyMinor: Math.round(annualMinor / 12) };
}

function sidesOf(
  capitalAnnualMinor: number,
  rentAnnualMinor: number,
): FireSustainableSpendingSides {
  return {
    capital: partOf(capitalAnnualMinor),
    total: partOf(capitalAnnualMinor + rentAnnualMinor),
  };
}

/**
 * Lo que un capital soporta al año si tiene que durar exactamente `years` y acabarse:
 * la anualidad `P · r / (1 − (1+r)^−n)`, en términos reales porque la tasa lo es.
 *
 * Con retorno cero (o por debajo de −100 %, que no compone) es un reparto lineal
 * `P / n`: el mismo resultado al que la fórmula tiende, sin dividir por cero.
 */
function annuityAnnualMinor(
  principalMinor: number,
  realReturn: number,
  years: number,
): number {
  if (realReturn === 0 || realReturn <= -1) {
    return Math.round(principalMinor / years);
  }
  const discount = 1 - Math.pow(1 + realReturn, -years);
  return Math.round((principalMinor * realReturn) / discount);
}

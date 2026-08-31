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
import type { FireCapitalAvailability } from "./fire-capital-availability";
import { availabilityAwareAnnuity } from "./fire-capital-availability";

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
  /**
   * Si la cifra la fijó una fecha de disponibilidad declarada y no el horizonte
   * completo (#1528, ADR 0100). `false` cuando nadie declaró nada o cuando el bloqueo
   * se libera antes de apretar: entonces esta cifra es la anualidad de siempre, y
   * decir que un bloqueo la recortó sería explicar un recorte inexistente.
   */
  limitedByAvailability: boolean;
}

/**
 * Por qué NO hay versión de agotamiento, cuando no la hay. Tres huecos distintos y
 * cada uno se arregla en otro sitio: una cifra que desaparece sin decir por qué se lee
 * como un fallo de la app, y pedir un dato que el usuario YA dio se lee como que no le
 * escuchamos.
 */
export type FireDepletionAbsence =
  /** No ha declarado hasta cuándo debe durar el capital. */
  | "no_final_age"
  /** Lo declaró, pero sin fecha de nacimiento no hay edad desde la que repartir (#1415). */
  | "no_reference_age"
  /** La edad final declarada ya se ha alcanzado: no quedan años que repartir. */
  | "final_age_reached";

export interface FireSustainableSpending {
  /** Las rentas netas declaradas del ámbito, o `null` si no hay ninguna. */
  rents: FireSustainableSpendingPart | null;
  /** Sin tocar el principal: `vendible × tasa de retirada`, para siempre. */
  perpetual: FireSustainableSpendingSides;
  /** Agotando el capital a la edad final declarada. `null` sin ese dato. */
  depletion: FireSustainableSpendingDepletion | null;
  /** Por qué falta `depletion`; `null` cuando está. */
  depletionAbsence: FireDepletionAbsence | null;
  /** El capital vendible del que sale la mitad de capital, neto de deuda y reserva. */
  sellableMinor: number;
  /** La tasa con la que se calculó la versión perpetua. */
  withdrawalRate: number;
  /** El retorno real con el que se anualizó la versión de agotamiento. */
  realReturnUsed: number;
  /**
   * El calendario del capital vendible con el que se repartió (#1528, ADR 0100): lo
   * bloqueado con fecha, lo que está a plazo sin declararla, y si se resolvió contra
   * un día. Viaja con la cifra para que la tarjeta pueda decir de dónde sale el
   * recorte —y nombrar el hueco— sin volver a calcular nada (ADR 0077).
   */
  availability: FireCapitalAvailability;
}

/** Lo que la tarjeta necesita del resultado FIRE — nada que ella pueda recalcular. */
export type FireSustainableSpendingInput = Pick<
  ScopeFireResult,
  "capitalSplit" | "context" | "rentReturns"
> &
  Partial<Pick<ScopeFireResult, "availability">>;

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

  // Sin campo = sin declaración, que es el estado por defecto y el que deja el reparto
  // exactamente como estaba. Es opcional en el tipo por eso y no por comodidad: la
  // ausencia de calendario y un calendario vacío significan lo mismo para la cifra.
  const availability: FireCapitalAvailability = input.availability ?? {
    lockedMinor: 0,
    resolved: false,
    tranches: [],
    undeclaredMinor: 0,
  };

  const currentAge = config.currentAge;
  const untilAge = config.capitalLastsUntilAge;
  const years =
    currentAge === undefined || untilAge === undefined ? 0 : untilAge - currentAge;
  // La única mitad con calendario, y por eso la única que la fecha declarada cambia
  // (#1528): la perpetua no toca el principal y el número FIRE no reparte por años.
  const annuity =
    untilAge !== undefined && years > 0
      ? availabilityAwareAnnuity({
          principalMinor: sellableMinor,
          realReturn: realReturnUsed,
          tranches: availability.tranches,
          years,
        })
      : null;
  const depletion =
    annuity !== null && untilAge !== undefined
      ? {
          ...sidesOf(annuity.annualMinor, rentAnnualMinor),
          limitedByAvailability: annuity.limitedByAvailability,
          untilAge,
          years,
        }
      : null;

  return {
    availability,
    depletion,
    // El hueco lleva su razón, y las tres son distintas: falta el campo, falta la fecha
    // de nacimiento de la que sale la edad de referencia, o esa edad ya llegó a la
    // final declarada. Pedirle la edad final a quien ya la puso sería no escucharle.
    depletionAbsence:
      depletion !== null
        ? null
        : untilAge === undefined
          ? "no_final_age"
          : currentAge === undefined
            ? "no_reference_age"
            : "final_age_reached",
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

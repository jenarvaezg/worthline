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
 * **Las rentas sin activo** (#1674, ADR 0111) — una pensión pública, una renta
 * vitalicia — entran por el mismo lado que los alquileres, y de dos maneras:
 *
 * - **Vigente hoy**: suma en la mitad de rentas, como un alquiler.
 * - **Empieza más adelante**: la tercera línea, con fecha — «desde 2030, X €/mes
 *   más». No se suma a ninguna cifra de hoy: el titular es lo que el capital de HOY
 *   soporta, y sumarle una renta que aún no llega sería el segundo reloj de arriba.
 *
 * La que llegará, solo mientras su **condición** se sostenga: una cifra que supone
 * cotizar hasta 2030 no aplica a quien declaró jubilarse antes (ADR 0074/0079). Se
 * contrasta aquí y no en el informe porque la edad de jubilación la teclea el
 * formulario de supuestos en vivo (#1450). La vigente no se contrasta: ya llega, y el
 * importe que llega no es una suposición.
 *
 * Puro: divide y anualiza lo que `calculateFireForScope` ya resolvió. No re-ensambla
 * el pool, no proyecta y no toca el número FIRE.
 */

import type { ScopeFireResult } from "./fire";
import type { FireCapitalAvailability } from "./fire-capital-availability";
import { availabilityAwareAnnuity } from "./fire-capital-availability";
import type { BirthDate } from "./fire-current-age";
import type {
  FireDeclaredRetirement,
  FireIncomeCondition,
  FireStandaloneIncome,
  FireWithheldStandaloneIncome,
} from "./fire-standalone-income";
import { incomeContributionCondition } from "./fire-standalone-income";

/** Una mitad del gasto sostenible: al año y al mes, la misma cifra. */
export interface FireSustainableSpendingPart {
  annualMinor: number;
  monthlyMinor: number;
}

/** Las dos mitades sumadas: lo que rinde el capital y lo que rinden las rentas. */
export interface FireSustainableSpendingSides {
  /** Lo que el capital vendible soporta. */
  capital: FireSustainableSpendingPart;
  /**
   * `capital` + los alquileres netos + las rentas sin activo vigentes hoy (#1674).
   * Las que empiezan más adelante NO están aquí: son la línea con fecha.
   */
  total: FireSustainableSpendingPart;
}

/** Una renta sin activo dentro de la tarjeta: al año, al mes y la condición que supone. */
export interface FireSustainableIncome extends FireSustainableSpendingPart {
  /** La declaración entera, con su procedencia y su fecha de corte (#1508). */
  income: FireStandaloneIncome;
  /**
   * Null cuando no declara condición, y siempre en una vigente: ya llega. Nunca
   * `broken` — una renta con la condición rota no está en la tarjeta.
   */
  condition: Exclude<FireIncomeCondition, { state: "broken" }> | null;
}

/**
 * Una renta cuya condición contradice la jubilación declarada: supone cotizar hasta
 * una fecha posterior al día en que el usuario dijo que se jubila. Sale de la tarjeta
 * y la tarjeta dice por qué — una cifra que desaparece en silencio se lee como un
 * fallo de la app, y una que se queda sobreestima lo que llegará.
 */
export interface FireConditionBrokenIncome extends FireSustainableSpendingPart {
  income: FireStandaloneIncome;
  /** Hasta cuándo supone cotizar la cifra. */
  throughISO: string;
  /** La jubilación declarada contra la que se rompe. */
  retirement: FireDeclaredRetirement;
}

/** Las rentas sin activo del ámbito, repartidas por lo que la tarjeta hace con ellas. */
export interface FireSustainableSpendingIncomes {
  /** Vigentes hoy: suman en el total. */
  current: FireSustainableIncome[];
  /** Empiezan más adelante: la tercera línea, con fecha. No suman en nada de hoy. */
  upcoming: FireSustainableIncome[];
  /** Su condición contradice la jubilación declarada: fuera, nombrando por qué. */
  conditionBroken: FireConditionBrokenIncome[];
  /** Fuera por su declaración o por no tener dueño en este ámbito (ADR 0108). */
  withheld: FireWithheldStandaloneIncome[];
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
  /** Los alquileres netos declarados del ámbito (ADR 0076), o `null` si no hay ninguno. */
  rents: FireSustainableSpendingPart | null;
  /** Las rentas sin activo: las que suman hoy, las que llegarán y las que no (#1674). */
  incomes: FireSustainableSpendingIncomes;
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
  "availability" | "capitalSplit" | "context" | "rentReturns" | "standaloneIncomes"
>;

/**
 * `null` cuando no hay tasa de retirada con la que dividir: sin ella no hay ni número
 * FIRE ni gasto sostenible, y la pantalla esconde las dos cifras a la vez.
 */
export function fireSustainableSpending(
  input: FireSustainableSpendingInput,
): FireSustainableSpending | null {
  const { availability, capitalSplit, context, rentReturns, standaloneIncomes } = input;
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

  const incomes = placeIncomes({
    referenceBirth: standaloneIncomes.referenceBirth,
    standalone: standaloneIncomes.readable,
    targetRetirementAge: config.targetRetirementAge,
    withheld: standaloneIncomes.withheld,
  });
  // La mitad de rentas de HOY: los alquileres y las rentas sin activo que ya llegan.
  const incomeAnnualMinor =
    rentAnnualMinor +
    incomes.current.reduce((total, line) => total + line.annualMinor, 0);

  const perpetual = sidesOf(
    Math.round(sellableMinor * withdrawalRate),
    incomeAnnualMinor,
  );

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
          ...sidesOf(annuity.annualMinor, incomeAnnualMinor),
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
    incomes,
    perpetual,
    realReturnUsed,
    rents,
    sellableMinor,
    withdrawalRate,
  };
}

/**
 * Coloca cada renta sin activo legible donde la tarjeta la lee: vigente, por venir o
 * fuera por su condición. Las retenidas pasan tal cual: su razón la decidió el informe.
 */
function placeIncomes(input: {
  standalone: readonly FireStandaloneIncome[];
  referenceBirth: BirthDate | null;
  targetRetirementAge: number | undefined;
  withheld: readonly FireWithheldStandaloneIncome[];
}): FireSustainableSpendingIncomes {
  const placed: FireSustainableSpendingIncomes = {
    conditionBroken: [],
    current: [],
    upcoming: [],
    withheld: [...input.withheld],
  };

  for (const income of input.standalone) {
    const amounts = partOf(income.annualMinor);
    if (!income.startsLater) {
      placed.current.push({ ...amounts, condition: null, income });
      continue;
    }
    const condition = incomeContributionCondition({
      assumedContributionThrough: income.assumedContributionThrough,
      referenceBirth: input.referenceBirth,
      targetRetirementAge: input.targetRetirementAge,
    });
    if (condition?.state === "broken") {
      placed.conditionBroken.push({
        ...amounts,
        income,
        retirement: condition.retirement,
        throughISO: condition.throughISO,
      });
      continue;
    }
    placed.upcoming.push({ ...amounts, condition, income });
  }

  return placed;
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

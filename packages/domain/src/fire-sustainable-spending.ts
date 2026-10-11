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
 * Y las dos solo mientras su **condición** se sostenga: una cifra que supone cotizar
 * hasta 2030 no aplica a quien declaró jubilarse antes (ADR 0074/0079). Se compara
 * contra la edad de jubilación DECLARADA —nunca contra el `?? 65` del motor ni contra
 * una fecha de cese inventada— y aquí, no en el informe, porque esa edad la teclea el
 * formulario de supuestos en vivo (#1450).
 *
 * Puro: divide y anualiza lo que `calculateFireForScope` ya resolvió. No re-ensambla
 * el pool, no proyecta y no toca el número FIRE.
 */

import type { ScopeFireResult } from "./fire";
import type { FireCapitalAvailability } from "./fire-capital-availability";
import { availabilityAwareAnnuity } from "./fire-capital-availability";
import type { BirthDate } from "./fire-current-age";
import type {
  FireStandaloneIncome,
  FireWithheldStandaloneIncome,
} from "./fire-standalone-income";

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

/**
 * Cómo está la condición de una renta frente a la jubilación declarada (#1674). Solo
 * las que se sostienen o no se pueden comprobar llegan a la tarjeta: la rota sale de
 * ella (`FireConditionBrokenIncome`).
 */
export type FireIncomeCondition =
  /** La jubilación declarada no es anterior: la cifra se enseña nombrando su condición. */
  | { state: "holds"; throughISO: string }
  /**
   * No hay contra qué comprobarla. Las dos faltas son distintas y se arreglan en sitios
   * distintos: la edad objetivo en los supuestos, la fecha de nacimiento en Ajustes.
   */
  | { state: "unchecked"; throughISO: string; missing: "retirement_age" | "birth_date" };

/** Una renta sin activo dentro de la tarjeta: al año, al mes y la condición que supone. */
export interface FireSustainableIncome extends FireSustainableSpendingPart {
  /** La declaración entera, con su procedencia y su fecha de corte (#1508). */
  income: FireStandaloneIncome;
  /** Null cuando la renta no declara condición ninguna. */
  condition: FireIncomeCondition | null;
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
  /**
   * La jubilación declarada situada en el calendario: la edad objetivo sobre la fecha
   * de nacimiento de referencia. `month` es null cuando solo se conoce el año.
   */
  retirement: { age: number; year: number; month: number | null };
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

  const incomes = sortIncomes({
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
 * Reparte las rentas sin activo legibles en vigentes, futuras y con la condición rota.
 * Las retenidas pasan tal cual: su razón la decidió el informe, no esta tarjeta.
 */
function sortIncomes(input: {
  standalone: readonly FireStandaloneIncome[];
  referenceBirth: BirthDate | null;
  /** La DECLARADA: el `?? 65` con el que el motor calcula no es una declaración. */
  targetRetirementAge: number | undefined;
  withheld: readonly FireWithheldStandaloneIncome[];
}): FireSustainableSpendingIncomes {
  const sorted: FireSustainableSpendingIncomes = {
    conditionBroken: [],
    current: [],
    upcoming: [],
    withheld: [...input.withheld],
  };
  const retirement = declaredRetirement(input.referenceBirth, input.targetRetirementAge);

  for (const income of input.standalone) {
    const throughISO = income.assumedContributionThrough;
    let condition: FireIncomeCondition | null = null;
    if (throughISO !== null) {
      if (input.targetRetirementAge === undefined) {
        condition = { missing: "retirement_age", state: "unchecked", throughISO };
      } else if (retirement === null) {
        condition = { missing: "birth_date", state: "unchecked", throughISO };
      } else if (retiresBefore(retirement, throughISO)) {
        sorted.conditionBroken.push({
          ...partOf(income.annualMinor),
          income,
          retirement,
          throughISO,
        });
        continue;
      } else {
        condition = { state: "holds", throughISO };
      }
    }
    const line = { ...partOf(income.annualMinor), condition, income };
    (income.startsLater ? sorted.upcoming : sorted.current).push(line);
  }

  return sorted;
}

/**
 * La jubilación declarada en el calendario: el año (y el mes, si se conoce) en que el
 * miembro de referencia cumple la edad objetivo. El cumpleaños cuenta desde el día 1
 * de su mes, la misma convención que `ageOnDate`.
 */
function declaredRetirement(
  birth: BirthDate | null,
  age: number | undefined,
): FireConditionBrokenIncome["retirement"] | null {
  if (birth === null || birth.birthYear === undefined || age === undefined) {
    return null;
  }
  return { age, month: birth.birthMonth ?? null, year: birth.birthYear + age };
}

/**
 * ¿Se jubila antes de lo que la cifra supone cotizar? Al mes cuando se sabe el mes;
 * con solo el año, el mismo año NO rompe la condición: no se sabe cuál de los dos
 * llega antes, y afirmar que la rompe sería inventarse el mes de nacimiento.
 */
function retiresBefore(
  retirement: FireConditionBrokenIncome["retirement"],
  throughISO: string,
): boolean {
  const throughYear = Number(throughISO.slice(0, 4));
  if (retirement.month === null) {
    return retirement.year < throughYear;
  }
  const throughMonth = Number(throughISO.slice(5, 7));
  return retirement.year * 12 + retirement.month < throughYear * 12 + throughMonth;
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

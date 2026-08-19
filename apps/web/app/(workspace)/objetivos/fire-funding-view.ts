/**
 * The progress questions the FIRE panel answers about FIRE and about Coast (#1426,
 * #1425).
 *
 * A big lone percentage reads as a probability — «tengo un 68,5 % de posibilidades
 * de llegar» — so the figure needs a noun and the fraction it came from. And the
 * bar's tick used to describe itself («el 84,2 % de tu número FIRE»), which is a
 * property of the tick, not of the reader's progress. The actionable pair is:
 *
 * - «llevo el 68,5 % de FIRE» → how far from living off this
 * - «llevo el ~81 % de Coast» → how far from being able to stop contributing
 *
 * Both are true and they answer different questions, so both are printed.
 *
 * Y aquí vive también la redacción del bloque de Coast (#1425): sus dos edades con la
 * premisa en la etiqueta, el «cuándo» que comparte con el rail de niveles, y la razón
 * por la que a veces no hay Coast en absoluto. Cuatro cifras vecinas que responden a
 * cuatro preguntas distintas se distinguen por cómo se dicen, así que se dicen en un
 * solo sitio.
 *
 * Pure: the amounts come from `calculateFireForScope` / `fireCoastArrival`, this module
 * only divides and words them (interaction-patterns §7).
 */

import type {
  FireCoastArrival,
  FireScopeConfig,
  ScopeFireResult,
} from "@worthline/domain";
import { formatFirePercent, formatRatePercent } from "./fire-percent";

/** Una fila del bloque de Coast: la cifra, su etiqueta y la premisa en letra pequeña. */
export interface FireCoastMetric {
  label: string;
  value: string;
  gloss: string;
}

const years = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

/**
 * «en ~4,6 años» / «este año» — cómo esta pantalla dice CUÁNDO, en un solo sitio. Las
 * tarjetas del rail de niveles y la fila de llegada a Coast lo preguntan del mismo
 * número, y escritas por separado tenían dos umbrales distintos para «este año»: un
 * cruce a 0,3 años se leía «en ~0,3 años» en una tarjeta y «este año» tres líneas más
 * arriba, en la misma pantalla.
 */
export function etaYearsLabel(value: number): string {
  return value < 0.5 ? "este año" : `en ~${years.format(value)} años`;
}

/**
 * «Llegas a Coast a los X» — la cifra que el tick de la barra siempre prometió y que
 * nadie calculaba (#1425). Tres estados, y ninguno se puede leer sin su premisa: la
 * edad supone las aportaciones DECLARADAS, el sello dice que ya no hacen falta y el
 * guion admite que con ese ahorro no se cruza. Null cuando no hay Coast del que hablar.
 */
export function coastArrivalMetric(
  arrival: FireCoastArrival | null,
  /**
   * La capacidad de ahorro declarada (unidades menores/mes). La glosa no puede
   * atribuirle la fecha a unas aportaciones que valen cero: cuando no hay ahorro
   * declarado, la llegada a Coast la trae el interés compuesto y solo él — y ese es
   * exactamente el caso en el que la edad de Coast se acerca a la de FIRE.
   */
  monthlySavingsMinor: number,
): FireCoastMetric | null {
  if (arrival === null) {
    return null;
  }

  const label = "Llegas a Coast";

  if (arrival.kind === "reached") {
    // Ya-en-Coast no pide edad, pide un sello — y el sello grande ya lo pone
    // `FireAchievementBadge` arriba; esta fila solo deja de mentir con una edad.
    return {
      gloss: "tu capital ya crece solo hasta tu número FIRE",
      label,
      value: "alcanzado",
    };
  }

  if (arrival.kind === "unreachable") {
    return {
      gloss: "con tu ahorro declarado no lo cruzas dentro de la proyección",
      label,
      value: "—",
    };
  }

  const when = etaYearsLabel(arrival.years);

  return {
    gloss:
      monthlySavingsMinor > 0
        ? `con tus aportaciones, ${when}`
        : `sin ahorro declarado, solo con el interés compuesto, ${when}`,
    label,
    value: `a los ${arrival.age}`,
  };
}

/**
 * La antigua «Edad Coast», con su premisa por nombre (#1425): la edad a la que el
 * capital de hoy llega al número FIRE COMPLETO si se deja de aportar ahora mismo. Es
 * otra pregunta que la de arriba, así que no lleva la palabra Coast delante — con ella,
 * las dos cifras se leían como la misma familia y una contradecía a la otra.
 *
 * Año entero: un decimal en una edad proyectada a diez años finge una precisión que no
 * existe (72,99 se imprimía como «73,0», que es lo que hacía parecer roto el cálculo).
 */
export function contributionsStopMetric(input: {
  result: ScopeFireResult;
  formatMoney: (amountMinor: number) => string;
}): FireCoastMetric | null {
  const { formatMoney, result } = input;
  const age = result.fireAgeIfContributionsStop;

  if (age === undefined) {
    return null;
  }

  // Su aritmética, como todas las de esta cadena (ADR 0077): el capital de hoy, la
  // tasa a la que crece, y el número FIRE que está impreso encima. Era la única fila
  // del bloque que se quedaba en cifra pelada.
  return {
    gloss: `${formatMoney(result.eligibleAssets.amountMinor)} creciendo al ${formatRatePercent(
      result.context.realReturnUsed,
    )}, sin aportar un euro más`,
    label: "Si dejas de aportar hoy",
    value: `FIRE a los ${Math.round(age)}`,
  };
}

/**
 * Por qué NO hay bloque de Coast teniendo edad (#1425, ADR 0079). Coast necesita margen
 * de composición hasta la edad objetivo, y sin él `calculateFire` no emite el requisito:
 * con retorno ≤ 0 no hay nada que «haga el resto», y con la edad objetivo ya pasada no
 * hay años que descontar. Una cifra que desaparece sin decir por qué se lee como un
 * fallo, así que el hueco lleva su razón — y las dos razones son distintas porque lo
 * que hay que cambiar es distinto. Null cuando el bloque sí se pinta, o cuando ni
 * siquiera hay edad (ahí habla el formulario de supuestos).
 */
export function coastAbsenceNote(input: {
  result: Pick<ScopeFireResult, "coastFireRequired">;
  config: FireScopeConfig;
  realReturnUsed: number;
}): string | null {
  const { config, realReturnUsed, result } = input;

  if (result.coastFireRequired !== undefined || config.currentAge === undefined) {
    return null;
  }

  if ((config.targetRetirementAge ?? 65) <= config.currentAge) {
    return "No hay Coast que calcular: tu edad objetivo ya ha llegado, así que no quedan años para que el capital crezca solo hasta tu número FIRE.";
  }

  return `No hay Coast que calcular: con una rentabilidad esperada del ${formatRatePercent(
    realReturnUsed,
  )} el capital no crece solo, así que no existe una cifra a partir de la cual puedas dejar de aportar.`;
}

/**
 * Progress toward the Coast requirement, as a percentage — «cuánto me falta para
 * poder dejar de aportar». Null when there is no coast requirement to measure against
 * (no age configured, or no compounding room before the target age — ADR 0079).
 */
export function coastProgressPercent(
  eligibleMinor: number,
  coastRequiredMinor: number | null | undefined,
): number | null {
  if (coastRequiredMinor == null || coastRequiredMinor <= 0) {
    return null;
  }
  return (eligibleMinor / coastRequiredMinor) * 100;
}

/**
 * The Coast requirement with the compound check behind it — the one link of the chain
 * «número FIRE → capital elegible → % → retorno ponderado → coast → escenarios» that
 * was still a bare figure. Null when there is no coast requirement, or when the years
 * to the target age cannot be read off the config.
 */
export function coastFormulaLine(input: {
  result: ScopeFireResult;
  config: FireScopeConfig;
  formatMoney: (amountMinor: number) => string;
}): string | null {
  const { config, formatMoney, result } = input;
  const coastRequired = result.coastFireRequired;
  const currentAge = config.currentAge;

  if (coastRequired === undefined || currentAge === undefined) {
    return null;
  }

  // The same horizon `calculateFire` compounds over: target age (65 by default) minus
  // the derived current age. Reading it off the config here keeps the sentence true
  // when the user moves either age.
  const years = (config.targetRetirementAge ?? 65) - currentAge;
  const rate = formatRatePercent(result.context.realReturnUsed);
  const yearsLabel = years === 1 ? "1 año" : `${years} años`;

  // Said in words, not in notation: «÷ (1 + r)^n» is the formula, but a reader checking
  // his own figure needs the sentence — the number, the horizon and the rate it was
  // discounted at.
  return `tu número FIRE descontado ${yearsLabel} al ${rate}: ${formatMoney(
    result.fireNumber.amountMinor,
  )} → ${formatMoney(coastRequired.amountMinor)}`;
}

/** The hero's funded figure with the noun and the division behind it. */
export interface FireFundedView {
  /** `68,5 %` — the percentage on its own, for the hero figure. */
  percent: string;
  /** `469.671 € de 685.714 €` — the fraction the percentage came from. */
  fraction: string;
}

export function fireFundedView(input: {
  result: ScopeFireResult;
  formatMoney: (amountMinor: number) => string;
}): FireFundedView {
  const { formatMoney, result } = input;

  return {
    fraction: `${formatMoney(result.eligibleAssets.amountMinor)} de ${formatMoney(
      result.fireNumber.amountMinor,
    )}`,
    percent: formatFirePercent(result.percentFunded),
  };
}

/**
 * La tarjeta del gasto sostenible, y el ofrecimiento que lleva a ella (#1428).
 *
 * Todas las palabras de la capa viven aquí, y tienen que ser coherentes entre sí:
 *
 * - El **encabezado**: qué pregunta lidera el panel. Es lo único que la capa cambia de
 *   la pantalla, así que la decisión se toma en un módulo con tests y no repartida por
 *   el JSX (interaction-patterns §7).
 * - El **ofrecimiento**: por qué la app sospecha que este plan no es FIRE. Se nombra la
 *   señal, no el veredicto — «tu edad objetivo son 67 años» es un hecho que el usuario
 *   reconoce; «no vas a hacer FIRE» es una conclusión sobre su vida.
 * - La **tarjeta**: la respuesta a «¿cuánto puedo gastar sin mermar mi patrimonio?»,
 *   partida en las dos mitades que la hacen honesta (rentas netas y capital vendible),
 *   con sus dos versiones y, cuando falta una, con la razón exacta de lo que falta.
 * - La **línea con fecha** (#1674): las rentas sin activo que empiezan más adelante
 *   —una pensión desde 2030—, cada una con su procedencia y su fecha de corte al lado,
 *   y la condición que supone. Las que no aplican salen nombrando por qué.
 *
 * Puro: las cifras vienen de `fireSustainableSpending` y `fireRetirementProfile`; aquí
 * solo se ponen en palabras. Ninguna línea vuelve a dividir nada — si una frase cita
 * una aritmética, cita la que produjo la cifra (ADR 0077).
 */

import { incomeProvenanceLine } from "@web/_income/income-view";
import type {
  FireConditionBrokenIncome,
  FireIncomeCondition,
  FireRetirementProfile,
  FireStandaloneIncomeWithholding,
  FireSustainableIncome,
  FireSustainableSpending,
  FireSustainableSpendingPart,
  FireWithheldStandaloneIncome,
  RentReturnNotice,
} from "@worthline/domain";
import { formatRatePercent } from "./fire-percent";
import { formatDay } from "./format-day";

/** Una fila de la tarjeta: de dónde sale el dinero, cuánto es y con qué aritmética. */
export interface FireSustainableSpendingRow {
  /** Único en la tarjeta: puede haber varias rentas sin activo vigentes. */
  id: string;
  /** Qué mitad es: alquileres, una renta sin activo o el capital. */
  key: "rents" | "income" | "capital";
  label: string;
  /** «97,92 €/mes» — la cifra mensual, que es la que el usuario piensa. */
  value: string;
  /** La aritmética o la procedencia, en una línea. */
  gloss: string;
}

/**
 * La tercera línea (#1674): una renta sin activo que empieza más adelante. No suma en
 * el titular —ese es lo que soporta el capital de HOY— y por eso lleva su fecha delante.
 */
export interface FireSustainableSpendingDatedRow {
  id: string;
  /** «Desde el 10 dic 2030», o «Del 10 nov 2030 al 10 nov 2063» si declara final. */
  when: string;
  label: string;
  /** «3.383,56 €/mes más». */
  value: string;
  /** De dónde sale, a qué fecha y qué supone (#1508): siempre junto a la cifra. */
  gloss: string;
}

export interface FireSustainableSpendingCopy {
  /** El titular: lo que puede gastar al mes sin mermar el patrimonio. */
  headline: string;
  /** El anual de ese mismo titular, para que la cifra no viaje sola. */
  headlineAnnual: string;
  /** Las mitades, en orden: primero lo que ya llega, después lo que el capital soporta. */
  rows: FireSustainableSpendingRow[];
  /** Las rentas que llegarán, por fecha. Vacío cuando no hay ninguna. */
  upcoming: FireSustainableSpendingDatedRow[];
  /**
   * Las rentas cuya condición contradice la jubilación declarada: fuera de la tarjeta,
   * nombrando la jubilación y el dato que falta. Null cuando no hay ninguna.
   */
  conditionNote: string | null;
  /** La versión de agotamiento, o el hueco con la razón de por qué no está. */
  depletion: { value: string; gloss: string } | null;
  /** Qué falta para poder enseñar la versión de agotamiento. Null cuando está. */
  depletionAbsence: string | null;
  /**
   * Lo que la fecha de disponibilidad declarada le hizo al reparto, o el hueco que
   * deja no haberla declarado (#1528, ADR 0100). Null cuando no hay ni bloqueo que
   * explicar ni capital a plazo sin fecha — el caso de casi todo el mundo.
   */
  availabilityNote: string | null;
  /** Qué patrimonio o qué rentas NO están en la cifra, cuando hay algo que decir. */
  exclusionNote: string | null;
}

type FormatMoney = (amountMinor: number) => string;

const monthly = (part: FireSustainableSpendingPart, formatMoney: FormatMoney): string =>
  `${formatMoney(part.monthlyMinor)}/mes`;

/** El encabezado del panel: la capa cambia la pregunta, no la pantalla. */
export function firePanelHeading(input: { ordinary: boolean; previewing: boolean }): {
  title: string;
  eyebrow: string;
} {
  return {
    eyebrow: input.previewing
      ? "previsualización · sin guardar"
      : input.ordinary
        ? "cuánto puedes gastar"
        : "objetivo principal",
    title: input.ordinary ? "Tu plan de jubilación" : "Independencia financiera · FIRE",
  };
}

/**
 * La tarjeta entera, en palabras. `immobilizedMinor` es el patrimonio que no entra en
 * ninguna de las dos mitades (el ladrillo y las colecciones): se nombra en vez de
 * ignorarse, porque un usuario que ve «puedes gastar 1.370 €/mes» teniendo 370.000 €
 * en pisos merece saber por qué esa cifra no los cuenta.
 */
export function fireSustainableSpendingCopy(input: {
  spending: FireSustainableSpending;
  formatMoney: FormatMoney;
  immobilizedMinor: number;
  /**
   * Los avisos del informe de rentas (#1448). De aquí sale qué alquileres declarados
   * NO están en la mitad de rentas y por qué: cada razón se dice con sus palabras, en
   * vez de hablar solo de la más común y callar las otras dos.
   */
  rentNotices: readonly RentReturnNotice[];
}): FireSustainableSpendingCopy {
  const { formatMoney, immobilizedMinor, spending } = input;
  const rate = formatRatePercent(spending.withdrawalRate);

  const rows: FireSustainableSpendingRow[] = [];
  if (spending.rents) {
    rows.push({
      gloss: `alquiler neto declarado: ${formatMoney(spending.rents.annualMinor)}/año`,
      id: "rents",
      key: "rents",
      label: "Tus rentas netas",
      value: monthly(spending.rents, formatMoney),
    });
  }
  // Las rentas sin activo que ya llegan, en la misma mitad que los alquileres (#1674):
  // una fila cada una, porque cada una tiene su procedencia y su fecha de corte.
  for (const line of spending.incomes.current) {
    rows.push({
      gloss: incomeGloss(line),
      id: `income-${line.income.incomeId}`,
      key: "income",
      label: line.income.label,
      value: monthly(line, formatMoney),
    });
  }
  rows.push({
    gloss: `${formatMoney(spending.sellableMinor)} de capital vendible × ${rate} ÷ 12`,
    id: "capital",
    key: "capital",
    label: "Lo que soporta tu capital",
    value: monthly(spending.perpetual.capital, formatMoney),
  });

  return {
    depletion: spending.depletion
      ? {
          gloss: `el mismo capital repartido hasta los ${spending.depletion.untilAge} (${spending.depletion.years} años) al ${formatRatePercent(
            spending.realReturnUsed,
          )}: aquí el principal se gasta`,
          value: monthly(spending.depletion.total, formatMoney),
        }
      : null,
    availabilityNote: availabilityNoteOf({ formatMoney, spending }),
    conditionNote: conditionNoteOf(spending.incomes.conditionBroken),
    depletionAbsence: depletionAbsenceNote(spending.depletionAbsence),
    exclusionNote: exclusionNoteOf({
      formatMoney,
      immobilizedMinor,
      rentNotices: input.rentNotices,
      withheldIncomes: spending.incomes.withheld,
    }),
    headline: monthly(spending.perpetual.total, formatMoney),
    headlineAnnual: `${formatMoney(spending.perpetual.total.annualMinor)}/año`,
    rows,
    upcoming: spending.incomes.upcoming.map((line) => ({
      gloss: incomeGloss(line),
      id: `income-${line.income.incomeId}`,
      label: line.income.label,
      value: `${monthly(line, formatMoney)} más`,
      when:
        line.income.endISO === null
          ? `Desde el ${formatDay(line.income.startISO)}`
          : `Del ${formatDay(line.income.startISO)} al ${formatDay(line.income.endISO)}`,
    })),
  };
}

/**
 * La procedencia y la condición de una renta, en la línea de su cifra (#1508): de dónde
 * sale, con datos a qué fecha, y qué supone. La procedencia es la MISMA frase que dice
 * la lista de Rentas, para que la renta no cuente dos historias.
 */
function incomeGloss(line: FireSustainableIncome): string {
  const provenance = incomeProvenanceLine(line.income);
  return line.condition === null
    ? provenance
    : `${provenance} · ${conditionClause(line.condition)}`;
}

function conditionClause(condition: FireIncomeCondition): string {
  const premise = `supone seguir cotizando hasta el ${formatDay(condition.throughISO)}`;
  if (condition.state === "holds") {
    return premise;
  }
  return condition.missing === "retirement_age"
    ? `${premise}, y sin edad de jubilación declarada no podemos contrastarlo`
    : `${premise}, y sin tu fecha de nacimiento no podemos situar tu jubilación para contrastarlo`;
}

const retirementMonthFormatter = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

/**
 * Las rentas que la jubilación declarada deja fuera (ADR 0074/0079): la cifra suponía
 * cotizar más allá del día en que el usuario dijo que se jubila. Se dice cuál, contra
 * qué fecha y qué dato falta — sin él, la renta que llegará es otra cifra.
 */
function conditionNoteOf(broken: readonly FireConditionBrokenIncome[]): string | null {
  if (broken.length === 0) {
    return null;
  }
  return broken
    .map(({ income, retirement, throughISO }) => {
      // Con solo el año no se sabe el mes, y decir uno sería inventárselo.
      const when =
        retirement.month === null
          ? `${retirement.year}`
          : retirementMonthFormatter.format(
              new Date(Date.UTC(retirement.year, retirement.month - 1, 1)),
            );
      return `«${income.label}» no está en esta tarjeta: supone seguir cotizando hasta el ${formatDay(throughISO)}, y declaraste jubilarte a los ${retirement.age}, en ${when}. Falta una cifra que suponga dejar de cotizar al jubilarte: una simulación a esa fecha, o tu edad de jubilación corregida.`;
    })
    .join(" ");
}

/**
 * Por qué no hay versión de agotamiento. Tres huecos y tres arreglos distintos, y esa
 * es toda la razón de que el motor los distinga: pedirle la edad final a quien ya la
 * declaró —porque lo que falta es su fecha de nacimiento— se lee como no escucharle.
 */
function depletionAbsenceNote(
  absence: FireSustainableSpending["depletionAbsence"],
): string | null {
  switch (absence) {
    case null:
      return null;
    case "no_final_age":
      return "Esta cifra no toca el principal. Dinos hasta qué edad debe durar tu capital y verás también lo que podrías gastar agotándolo.";
    case "no_reference_age":
      return "Para repartir tu capital hasta esa edad nos falta tu fecha de nacimiento: rellénala en Ajustes → Miembros y aparecerá la segunda cifra.";
    case "final_age_reached":
      return "Tu edad ya ha alcanzado la edad final que declaraste, así que no quedan años entre los que repartir el capital.";
  }
}

/**
 * Lo que la disponibilidad declarada dice de esta tarjeta (#1528, ADR 0100). Dos frases
 * distintas y nunca a la vez:
 *
 * - **Hubo recorte**: el reparto no promete, en los primeros años, dinero que todavía no
 *   se puede tocar. Se nombra el bloqueo porque, si no, la segunda cifra baja sin
 *   explicación y se lee como un fallo de la app.
 * - **Falta la fecha**: hay capital a plazo que nadie ha fechado, y el reparto lo está
 *   contando como disponible desde el primer año. El hueco se dice en voz alta y se dice
 *   dónde se arregla; callarlo sería la ilusión de liquidez que #1447 vino a matar.
 *
 * Y antes que las dos, la que no depende del usuario: **el calendario no se resolvió**
 * porque quien pidió la cifra no trajo día (`resolved === false`, ADR 0100 §5). Entonces
 * el reparto es el de siempre aunque haya fechas declaradas, y esta tarjeta lo dice en vez
 * de imprimir «sin bloqueos» — que sería afirmar algo que nadie ha comprobado.
 *
 * El recorte manda sobre el hueco cuando se dan los dos: la cifra que el usuario está
 * mirando ya cambió, y esa es la que hay que explicar primero.
 */
function availabilityNoteOf(input: {
  formatMoney: FormatMoney;
  spending: FireSustainableSpending;
}): string | null {
  const { formatMoney, spending } = input;
  const { availability, depletion } = spending;

  // Sin día no se resolvió nada, y lo declarado sigue ahí: decirlo es la única forma
  // de que la ausencia de bloqueo no se lea como ausencia de fechas (ADR 0100 §5).
  if (!availability.resolved && availability.declaredMinor > 0) {
    return `Hay ${formatMoney(availability.declaredMinor)} con fecha de disponibilidad declarada que esta pantalla no ha situado en el calendario, así que el reparto de abajo los cuenta como disponibles desde el primer año.`;
  }

  if (depletion?.limitedByAvailability) {
    return `De tu capital vendible, ${formatMoney(availability.lockedMinor)} tienen fecha de disponibilidad declarada, así que la cifra de agotamiento no lo reparte antes de que puedas tocarlo.`;
  }

  if (availability.undeclaredMinor > 0) {
    return `Tienes ${formatMoney(availability.undeclaredMinor)} en el escalón «A plazo» sin fecha de disponibilidad declarada: hasta que la digas en su ficha, el reparto los cuenta como disponibles desde el primer año.`;
  }

  return null;
}

/**
 * Lo que la tarjeta deja fuera, dicho en voz alta: el patrimonio inmovilizado (que no
 * se gasta a plazos, y por eso solo cuenta a través de su renta) y los alquileres
 * declarados que no suman en la mitad de rentas, cada uno con su razón. Null cuando no
 * hay nada que excluir.
 */
function exclusionNoteOf(input: {
  formatMoney: FormatMoney;
  immobilizedMinor: number;
  rentNotices: readonly RentReturnNotice[];
  withheldIncomes: readonly FireWithheldStandaloneIncome[];
}): string | null {
  const { formatMoney, immobilizedMinor } = input;
  const parts: string[] = [];

  if (immobilizedMinor > 0) {
    parts.push(
      `Tus ${formatMoney(immobilizedMinor)} de patrimonio inmovilizado (vivienda no habitual, colecciones) no están en esta cifra: no se gastan a plazos, solo a través de lo que rentan.`,
    );
  }

  const rentGap = rentGapClause(input.rentNotices);
  if (rentGap !== null) {
    parts.push(rentGap);
  }

  const incomeGap = withheldIncomesClause(input.withheldIncomes);
  if (incomeGap !== null) {
    parts.push(incomeGap);
  }

  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * Por qué una renta sin activo no suma (#1674, ADR 0108). Por nombre, no por razón
 * agregada como los alquileres: son pocas, no tienen ficha de activo donde verse, y
 * «una pensión no suma» sin decir cuál obliga a buscarla.
 */
const WITHHELD_INCOME_REASON: Record<FireStandaloneIncomeWithholding, string> = {
  missing_amount_basis: "su importe está sin declarar como real o nominal",
  missing_nature: "su naturaleza está sin declarar",
  // El aviso del ticket: un importe fijo a fecha futura no es real, y tratarlo como tal
  // se equivoca en la dirección peligrosa. Nunca se le inventa una tasa de decaimiento.
  nominal_amount:
    "su importe es nominal: a fecha futura no son euros de hoy, y contarlo como tales sobreestimaría lo que te llegará",
  ownerless_in_partial_scope:
    "no tiene dueño declarado y este ámbito no incluye a todos los miembros",
  work_income: "es renta del trabajo, no vivir de tus activos",
};

function withheldIncomesClause(
  withheld: readonly FireWithheldStandaloneIncome[],
): string | null {
  if (withheld.length === 0) {
    return null;
  }
  const clauses = withheld.map(
    (income) => `«${income.label}», porque ${WITHHELD_INCOME_REASON[income.reason]}`,
  );
  return `Rentas sin activo que no suman aquí: ${clauses.join("; ")}.`;
}

/**
 * Los alquileres declarados que NO están en la mitad de rentas, por razón. El aviso de
 * `immobilized_not_counted` no cuenta: ese alquiler SÍ suma aquí (la declaración de
 * #1460 habla de capital, no de ingresos), y anunciarlo como ausente sería mentir en la
 * dirección contraria.
 */
function rentGapClause(notices: readonly RentReturnNotice[]): string | null {
  const reasons = new Set(notices.map((notice) => notice.reason));
  const clauses: string[] = [];

  if (reasons.has("missing_expenses")) {
    clauses.push("les faltan los gastos declarados");
  }
  if (reasons.has("no_live_schedule")) {
    clauses.push("no están vigentes hoy");
  }
  if (reasons.has("foreign_currency")) {
    clauses.push("están en una divisa que sus cobros no declaran");
  }
  if (reasons.has("nominal_rent_revision")) {
    clauses.push("su renta no se revisa, así que su rendimiento no es real");
  }
  if (reasons.has("missing_nature")) {
    clauses.push("su naturaleza está sin declarar");
  }
  if (reasons.has("work_income")) {
    clauses.push("son rentas del trabajo");
  }
  if (reasons.has("missing_amount_basis")) {
    clauses.push("su importe está sin declarar como real o nominal");
  }
  if (reasons.has("nominal_amount")) {
    clauses.push("su importe es nominal, no está expresado en euros de hoy");
  }

  if (clauses.length === 0) {
    return null;
  }

  return `Y hay alquileres declarados que no suman aquí: ${clauses.join("; ")}. Mientras sea así, contarlos sobreestimaría lo que te queda.`;
}

/**
 * El ofrecimiento: la señal en un hecho reconocible y la pregunta. Null cuando no hay
 * nada que ofrecer — sin señales, o con la elección ya hecha en cualquiera de los dos
 * sentidos.
 */
export function fireRetirementOfferLine(profile: FireRetirementProfile): string | null {
  if (profile.state !== "offer") {
    return null;
  }

  const reasons = profile.signals.map((signal) =>
    signal.kind === "target_age_is_ordinary"
      ? `tu edad objetivo son ${signal.targetRetirementAge} años, no una jubilación anticipada`
      : "con tu ahorro declarado no alcanzas tu número FIRE dentro de la proyección",
  );

  return `Parece que tu plan es una jubilación ordinaria: ${reasons.join(" y ")}.`;
}

/**
 * Cómo se dice, dentro del estado «jubilación ordinaria», que el FIRE sigue ahí. El
 * porcentaje financiado no se borra —es cierto— pero deja de ser el titular cuando el
 * titular no aplica.
 */
export function fireOrdinaryPlanNote(percentFunded: string): string {
  return `Tu número FIRE sigue calculado: ${percentFunded} financiado.`;
}

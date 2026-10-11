/**
 * Las rentas sin activo que el gasto sostenible de un ámbito puede leer (#1674, S3 de
 * #1522, ADR 0111).
 *
 * Una pensión pública, una renta vitalicia: dinero que llega sin que ningún activo lo
 * genere. Hasta S2 no había forma de declararlas sin inventarse un piso, y hasta aquí
 * ninguna cifra las leía. Este módulo decide, una vez y para todas las superficies,
 * cuáles puede leer la tarjeta y cuáles no, con su razón.
 *
 * El informe decide lo que los supuestos NO mueven: la declaración (naturaleza, base
 * del importe), la ventana y a qué ámbito pertenece la renta. La condición —si la
 * jubilación declarada contradice lo que la cifra supone cotizar— depende de la edad
 * objetivo, que el formulario de supuestos deja teclear en vivo (#1450): por eso
 * `incomeContributionCondition` vive aquí pero se llama después, desde
 * `fireSustainableSpending`, con el `config` que esté en pantalla y la fecha de
 * nacimiento que este informe lleva.
 *
 * Tres reglas:
 *
 * 1. **Solo las rentas sin activo.** Una renta enlazada tiene ya su camino: la de un
 *    piso sustituye la tasa de su escalón (ADR 0076), y la de un fondo o un depósito
 *    es parte del rendimiento que el capital ya aporta — sumarla otra vez sería contar
 *    el mismo dinero dos veces (el cruce de doble conteo es S4, #1675).
 * 2. **Pasiva y real, o nada** (ADR 0108). Sin naturaleza o sin base no se asume nada;
 *    el trabajo no es vivir de tus activos (#1463); y un importe nominal a fecha futura
 *    no son euros de hoy — leerlo como tal sobreestima en la dirección peligrosa, y
 *    worthline no le inventa una tasa de decaimiento (mismo veto que `rent_revision =
 *    fixed`, #1521).
 * 3. **Sin dueño declarado.** Una renta sin activo no tiene reparto de propiedad, así
 *    que solo se sabe que pertenece a ALGUIEN del espacio: cuenta entera en un ámbito
 *    que cubre a todos los miembros activos, y en uno parcial no se le atribuye a nadie.
 *    Atribuírsela al miembro que se está mirando sería inventar de quién es.
 *
 * Puro: ISO dentro, céntimos fuera. Sin reloj ni base de datos.
 */

import type { BirthDate } from "./fire-current-age";
import { parseCalendarMonth, scopeAgeSource } from "./fire-current-age";
import { annualizedMinor } from "./fire-rent-return";
import type { Income, IncomeExclusionReason, IncomeProvenance } from "./payouts";
import { incomeExclusionReason } from "./payouts";
import { findScopeMemberIds } from "./scope";
import type { Workspace } from "./workspace-types";

/** Una renta sin activo que la tarjeta puede leer: pasiva, real y del ámbito. */
export interface FireStandaloneIncome {
  incomeId: string;
  label: string;
  /**
   * Lo que llega al año, neto de los gastos declarados. Sin gastos declarados no se
   * resta nada: el «neto o nada» de ADR 0076 es de un alquiler, que tiene agencia, IBI
   * y meses vacíos; una pensión no los tiene (#1510).
   */
  annualMinor: number;
  startISO: string;
  endISO: string | null;
  /** Empieza después de hoy: la tercera línea de la tarjeta, la que lleva fecha. */
  startsLater: boolean;
  /** Hasta cuándo supone la cifra que se sigue cotizando; null sin condición. */
  assumedContributionThrough: string | null;
  /** De dónde sale la cifra; null en una renta migrada que aún no lo ha dicho. */
  provenance: IncomeProvenance | null;
  /** La fecha de corte de esos datos, nunca la de cuando se teclearon. */
  provenanceAsOf: string | null;
}

/**
 * Por qué una renta sin activo NO entra. Las de la declaración son las de ADR 0108,
 * con la misma frase en todas partes; la del dueño es propia de la tarjeta.
 */
export type FireStandaloneIncomeWithholding =
  | IncomeExclusionReason
  /** El ámbito no cubre a todos los miembros, y la renta no dice de cuál es. */
  | "ownerless_in_partial_scope";

export interface FireWithheldStandaloneIncome {
  incomeId: string;
  label: string;
  reason: FireStandaloneIncomeWithholding;
}

export interface FireStandaloneIncomeReport {
  /** Las que la tarjeta puede leer, por fecha de inicio: el orden en que llegan. */
  readable: FireStandaloneIncome[];
  /** Las vigentes o por venir que no entran, con su razón. Las terminadas, ni eso. */
  withheld: FireWithheldStandaloneIncome[];
  /**
   * La fecha de nacimiento de la que sale la edad de referencia del ámbito (ADR 0073):
   * contra ella se sitúa en el calendario la jubilación declarada para comprobar la
   * condición de cada renta. Null cuando ningún miembro del ámbito la tiene.
   */
  referenceBirth: BirthDate | null;
}

/** Lo que produce un ámbito al que nadie le ha traído rentas. */
export const NO_STANDALONE_INCOMES: FireStandaloneIncomeReport = {
  readable: [],
  referenceBirth: null,
  withheld: [],
};

export interface DeriveStandaloneIncomesInput {
  /** Todas las rentas declaradas; las enlazadas a un activo se ignoran aquí. */
  incomes: readonly Income[];
  /** El día de la pantalla (ADR 0024): qué ha empezado y qué ha terminado. */
  todayISO: string;
  workspace: Workspace;
  scopeId: string;
}

export function deriveStandaloneIncomes(
  input: DeriveStandaloneIncomesInput,
): FireStandaloneIncomeReport {
  const { incomes, scopeId, todayISO, workspace } = input;
  const coversEveryMember = scopeCoversEveryMember(workspace, scopeId);

  const readable: FireStandaloneIncome[] = [];
  const withheld: FireWithheldStandaloneIncome[] = [];

  for (const income of incomes) {
    if (income.holdingId !== null) continue;
    // Una renta que ya terminó no es dinero que llegue, ni hoy ni más adelante: la
    // lista de Rentas dice cuándo terminó, y la tarjeta no tiene nada que añadir.
    if (income.endISO !== null && income.endISO < todayISO) continue;

    // El dueño va antes que la declaración a propósito: en un ámbito parcial,
    // declarar la naturaleza no la haría contar, y pedirlo sería prometer algo que
    // la tarjeta no va a cumplir.
    const reason: FireStandaloneIncomeWithholding | null = coversEveryMember
      ? incomeExclusionReason(income)
      : "ownerless_in_partial_scope";
    if (reason !== null) {
      withheld.push({ incomeId: income.id, label: income.label, reason });
      continue;
    }

    readable.push({
      annualMinor:
        annualizedMinor(income.amountMinor, income.cadence) -
        annualizedMinor(income.expensesMinor ?? 0, income.cadence),
      assumedContributionThrough: income.assumedContributionThrough,
      endISO: income.endISO,
      incomeId: income.id,
      label: income.label,
      provenance: income.provenance,
      provenanceAsOf: income.provenanceAsOf,
      startISO: income.startISO,
      startsLater: income.startISO > todayISO,
    });
  }

  readable.sort(
    (a, b) =>
      a.startISO.localeCompare(b.startISO) ||
      a.label.localeCompare(b.label, "es") ||
      a.incomeId.localeCompare(b.incomeId),
  );

  const source = scopeAgeSource(workspace, scopeId, todayISO);
  return {
    readable,
    referenceBirth:
      source === undefined
        ? null
        : {
            birthYear: source.birthYear,
            ...(source.birthMonth === undefined ? {} : { birthMonth: source.birthMonth }),
          },
    withheld,
  };
}

/** Si el ámbito incluye a cada miembro activo del espacio: el único sitio seguro. */
function scopeCoversEveryMember(workspace: Workspace, scopeId: string): boolean {
  const inScope = new Set(findScopeMemberIds(workspace, scopeId) ?? []);
  const everyone = findScopeMemberIds(workspace, "household") ?? [];
  return everyone.every((memberId) => inScope.has(memberId));
}

// ── la condición (ADR 0074/0079) ──────────────────────────────────────────────

/**
 * La jubilación declarada situada en el calendario: el año (y el mes, si se conoce) en
 * que el miembro de referencia cumple la edad objetivo DECLARADA.
 */
export interface FireDeclaredRetirement {
  age: number;
  year: number;
  /** Null cuando del miembro de referencia solo se conoce el año de nacimiento. */
  month: number | null;
}

/**
 * Cómo está la condición de una renta —«supone cotizar hasta 2030»— frente a la
 * jubilación declarada. Una cifra que supone cotizar más allá del día en que el usuario
 * dijo que se jubila no aplica; una que no se puede contrastar se enseña nombrando con
 * qué no se pudo.
 */
export type FireIncomeCondition =
  /** La jubilación declarada no es anterior: la cifra se enseña nombrando su condición. */
  | { state: "holds"; throughISO: string }
  /**
   * No hay contra qué contrastarla, y cada falta se arregla en un sitio distinto: la
   * edad objetivo en los supuestos, la fecha de nacimiento en Ajustes, y el mes de
   * nacimiento cuando con solo el año la jubilación y la condición caen el mismo año.
   */
  | {
      state: "unchecked";
      throughISO: string;
      missing: "retirement_age" | "birth_date" | "birth_month";
    }
  /** La jubilación declarada es anterior: la cifra supone cotizar de más. */
  | { state: "broken"; throughISO: string; retirement: FireDeclaredRetirement };

/**
 * Contrasta la condición de una renta con la jubilación declarada. Null cuando la renta
 * no declara condición ninguna.
 *
 * La edad es la DECLARADA: el `?? 65` con el que el motor calcula no es una declaración
 * (ADR 0081), y comparar contra él le diría a quien nunca tocó el campo que su pensión
 * no aplica por una edad que no escribió. Y nunca contra una fecha de cese inventada:
 * worthline no tiene escenarios de cese.
 *
 * La granularidad es el mes, porque es la del dato: del cumpleaños se sabe el mes, no
 * el día. Jubilarse el mismo mes en que la cifra deja de cotizar es el caso coherente —
 * una simulación hecha a la fecha de jubilación supone cotizar hasta ese mes— y se
 * sostiene. Con solo el año, caer el mismo año no se puede decidir sin inventarse el
 * mes, y se dice así.
 */
export function incomeContributionCondition(input: {
  assumedContributionThrough: string | null;
  referenceBirth: BirthDate | null;
  targetRetirementAge: number | undefined;
}): FireIncomeCondition | null {
  const throughISO = input.assumedContributionThrough;
  if (throughISO === null) {
    return null;
  }
  const age = input.targetRetirementAge;
  if (age === undefined) {
    return { missing: "retirement_age", state: "unchecked", throughISO };
  }
  const birthYear = input.referenceBirth?.birthYear;
  if (birthYear === undefined) {
    return { missing: "birth_date", state: "unchecked", throughISO };
  }

  const retirement: FireDeclaredRetirement = {
    age,
    month: parseCalendarMonth(input.referenceBirth?.birthMonth) ?? null,
    year: birthYear + age,
  };
  const throughYear = Number(throughISO.slice(0, 4));
  const throughMonth = parseCalendarMonth(Number(throughISO.slice(5, 7)));

  if (retirement.month === null || throughMonth === undefined) {
    if (retirement.year === throughYear) {
      return { missing: "birth_month", state: "unchecked", throughISO };
    }
    return retirement.year < throughYear
      ? { retirement, state: "broken", throughISO }
      : { state: "holds", throughISO };
  }
  return retirement.year * 12 + retirement.month < throughYear * 12 + throughMonth
    ? { retirement, state: "broken", throughISO }
    : { state: "holds", throughISO };
}

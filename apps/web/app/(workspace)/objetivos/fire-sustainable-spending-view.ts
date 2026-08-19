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
 *
 * Puro: las cifras vienen de `fireSustainableSpending` y `fireRetirementProfile`; aquí
 * solo se ponen en palabras. Ninguna línea vuelve a dividir nada — si una frase cita
 * una aritmética, cita la que produjo la cifra (ADR 0077).
 */

import type {
  FireRetirementProfile,
  FireSustainableSpending,
  FireSustainableSpendingPart,
  RentReturnNotice,
} from "@worthline/domain";
import { formatRatePercent } from "./fire-percent";

/** Una fila de la tarjeta: de dónde sale el dinero, cuánto es y con qué aritmética. */
export interface FireSustainableSpendingRow {
  key: "rents" | "capital";
  label: string;
  /** «97,92 €/mes» — la cifra mensual, que es la que el usuario piensa. */
  value: string;
  /** La aritmética o la procedencia, en una línea. */
  gloss: string;
}

export interface FireSustainableSpendingCopy {
  /** El titular: lo que puede gastar al mes sin mermar el patrimonio. */
  headline: string;
  /** El anual de ese mismo titular, para que la cifra no viaje sola. */
  headlineAnnual: string;
  /** Las mitades, en orden: primero lo que ya llega, después lo que el capital soporta. */
  rows: FireSustainableSpendingRow[];
  /** La versión de agotamiento, o el hueco con la razón de por qué no está. */
  depletion: { value: string; gloss: string } | null;
  /** Qué falta para poder enseñar la versión de agotamiento. Null cuando está. */
  depletionAbsence: string | null;
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
      key: "rents",
      label: "Tus rentas netas",
      value: monthly(spending.rents, formatMoney),
    });
  }
  rows.push({
    gloss: `${formatMoney(spending.sellableMinor)} de capital vendible × ${rate} ÷ 12`,
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
    depletionAbsence: depletionAbsenceNote(spending.depletionAbsence),
    exclusionNote: exclusionNoteOf({
      formatMoney,
      immobilizedMinor,
      rentNotices: input.rentNotices,
    }),
    headline: monthly(spending.perpetual.total, formatMoney),
    headlineAnnual: `${formatMoney(spending.perpetual.total.annualMinor)}/año`,
    rows,
  };
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
 * Lo que la tarjeta deja fuera, dicho en voz alta: el patrimonio inmovilizado (que no
 * se gasta a plazos, y por eso solo cuenta a través de su renta) y los alquileres
 * declarados que no suman en la mitad de rentas, cada uno con su razón. Null cuando no
 * hay nada que excluir.
 */
function exclusionNoteOf(input: {
  formatMoney: FormatMoney;
  immobilizedMinor: number;
  rentNotices: readonly RentReturnNotice[];
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

  return parts.length === 0 ? null : parts.join(" ");
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

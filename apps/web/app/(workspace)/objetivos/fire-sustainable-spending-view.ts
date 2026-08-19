/**
 * La tarjeta del gasto sostenible, y el ofrecimiento que lleva a ella (#1428).
 *
 * Dos redacciones que tienen que ser coherentes entre sí, así que viven juntas:
 *
 * - El **ofrecimiento**: por qué la app sospecha que este plan no es FIRE. Se nombra
 *   la señal, no el veredicto — «tu edad objetivo son 67 años» es un hecho que el
 *   usuario reconoce; «no vas a hacer FIRE» es una conclusión sobre su vida.
 * - La **tarjeta**: la respuesta a «¿cuánto puedo gastar sin mermar mi patrimonio?»,
 *   partida en las dos mitades que la hacen honesta (rentas netas y capital vendible)
 *   y con las dos versiones que tiene (perpetua y de agotamiento).
 *
 * Puro: las cifras vienen de `fireSustainableSpending` y `fireRetirementProfile`; aquí
 * solo se ponen en palabras (interaction-patterns §7). Ninguna línea vuelve a dividir
 * nada — si una frase cita una aritmética, cita la que produjo la cifra (ADR 0077).
 */

import type {
  FireRetirementProfile,
  FireSustainableSpending,
  FireSustainableSpendingPart,
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
  /** La versión de agotamiento, o la invitación a rellenar la edad final. */
  depletion: { value: string; gloss: string } | null;
  /** Qué patrimonio NO está en ninguna de las dos mitades, cuando lo hay. */
  exclusionNote: string | null;
}

const monthly = (part: FireSustainableSpendingPart, formatMoney: FormatMoney): string =>
  `${formatMoney(part.monthlyMinor)}/mes`;

type FormatMoney = (amountMinor: number) => string;

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
  /** Hay alquileres declarados a los que les faltan los gastos (#1448): valen 0 aquí. */
  hasRentsPendingExpenses: boolean;
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
    exclusionNote: exclusionNoteOf({
      formatMoney,
      hasRentsPendingExpenses: input.hasRentsPendingExpenses,
      immobilizedMinor,
    }),
    headline: monthly(spending.perpetual.total, formatMoney),
    headlineAnnual: `${formatMoney(spending.perpetual.total.annualMinor)}/año`,
    rows,
  };
}

/**
 * Lo que la tarjeta deja fuera, dicho en voz alta. Dos huecos distintos y los dos
 * accionables: el patrimonio inmovilizado (que no se gasta a plazos, y por eso solo
 * cuenta a través de su renta) y los alquileres sin gastos declarados (que valen 0
 * hasta que se declaren, ADR 0076). Null cuando no hay ninguno de los dos.
 */
function exclusionNoteOf(input: {
  formatMoney: FormatMoney;
  hasRentsPendingExpenses: boolean;
  immobilizedMinor: number;
}): string | null {
  const { formatMoney, hasRentsPendingExpenses, immobilizedMinor } = input;
  const parts: string[] = [];

  if (immobilizedMinor > 0) {
    parts.push(
      `Tus ${formatMoney(immobilizedMinor)} de patrimonio inmovilizado (vivienda no habitual, colecciones) no están en esta cifra: no se gastan a plazos, solo a través de lo que rentan.`,
    );
  }
  if (hasRentsPendingExpenses) {
    parts.push(
      "Y hay alquileres declarados sin gastos: hasta que los declares no suman aquí, porque el bruto sobreestimaría lo que te queda.",
    );
  }

  return parts.length === 0 ? null : parts.join(" ");
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

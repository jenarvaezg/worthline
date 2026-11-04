/**
 * A contribution cadence in words, for the middle of a sentence: «50 € el día 5 de
 * cada mes». One vocabulary for every surface that says a plan's or a schedule's
 * periodicity, matching the plan's own cadence labels (Semanal, Mensual,
 * Trimestral, Anual). Pure.
 */

import type { ContributionCadence, IsoWeekday } from "@worthline/domain";

const WEEKDAYS: Record<IsoWeekday, string> = {
  1: "lunes",
  2: "martes",
  3: "miércoles",
  4: "jueves",
  5: "viernes",
  6: "sábado",
  7: "domingo",
};

export function contributionCadenceWords(cadence: ContributionCadence): string {
  switch (cadence.kind) {
    case "monthly":
      return `el día ${cadence.dayOfMonth} de cada mes`;
    case "weekly":
      return `cada ${WEEKDAYS[cadence.weekday]}`;
    case "quarterly":
      return "cada trimestre";
    case "annual":
      return "cada año";
  }
}

import type { AmortizationScheduleImportPlan } from "@worthline/domain";

/**
 * The sentences the cuadro preview says out loud, as a pure module (#1406,
 * interaction-patterns §7): what will be written, whether our curve reproduces
 * the balances the document declares, and — when it does not — what confirming
 * will do anyway.
 *
 * A mismatch does NOT lock the button (ADR 0070 §4). The user is the one who
 * knows whether the bank's paper or our model is right, and a door that only
 * says «no cuadra» leaves them exactly where #1422 left Jorge: correct, and
 * without a button. What the surface owes is the figures and the consequence.
 */

export type ScheduleVerdict = "verified" | "partial" | "unverified" | "nothing-to-check";

export function scheduleVerdict(plan: AmortizationScheduleImportPlan): ScheduleVerdict {
  const { agreeingCount, checkedCount } = plan.summary;
  if (checkedCount === 0) return "nothing-to-check";
  if (agreeingCount === checkedCount) return "verified";
  return agreeingCount === 0 ? "unverified" : "partial";
}

/** Whether the import has anything left to write. */
export function scheduleWritesSomething(plan: AmortizationScheduleImportPlan): boolean {
  return plan.summary.newRevisionCount + plan.summary.newEarlyRepaymentCount > 0;
}

export function pluralize(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** «3 revisiones de tipo y 2 amortizaciones anticipadas». */
export function scheduleWriteSentence(plan: AmortizationScheduleImportPlan): string {
  const { newEarlyRepaymentCount, newRevisionCount } = plan.summary;
  const revisions = pluralize(newRevisionCount, "revisión de tipo", "revisiones de tipo");
  if (newEarlyRepaymentCount === 0) return revisions;
  return `${revisions} y ${pluralize(
    newEarlyRepaymentCount,
    "amortización anticipada",
    "amortizaciones anticipadas",
  )}`;
}

export type MinorFormatter = (minor: number) => string;

/**
 * The guarantee line: a cuadro prints both the causes and their consequences, so
 * it can check our reading of it. This is that check, said in one sentence.
 */
export function scheduleVerificationSentence(
  plan: AmortizationScheduleImportPlan,
  format: MinorFormatter,
): string {
  const { agreeingCount, checkedCount, worstDrift } = plan.summary;

  switch (scheduleVerdict(plan)) {
    case "nothing-to-check":
      return "Este cuadro no declara saldos, así que no puedo comprobar la lectura contra él. Revisa las revisiones una a una antes de confirmar.";
    case "verified":
      return `La curva resultante reproduce ${pluralize(
        checkedCount,
        "el saldo que el cuadro declara",
        "los saldos que el cuadro declara",
      )}. La lectura es correcta.`;
    case "partial":
      return `La curva reproduce ${agreeingCount} de ${checkedCount} saldos del cuadro. El que más se desvía es el de ${
        worstDrift?.dateKey
      }, por ${format(Math.abs(worstDrift?.deltaMinor ?? 0))}: suele faltar una amortización anticipada que el cuadro sí trae en otra columna.`;
    case "unverified":
      return `La curva NO reproduce ninguno de los ${checkedCount} saldos del cuadro (el mayor desvío, ${format(
        Math.abs(worstDrift?.deltaMinor ?? 0),
      )} el ${worstDrift?.dateKey}). Puedes cargarlo igualmente, pero revisa antes que sea el cuadro de esta deuda.`;
  }
}

/** What a re-baselined stretch means for the import, or null when there is none. */
export function rebaselineNoticeSentence(
  plan: AmortizationScheduleImportPlan,
): string | null {
  const covered = plan.checkpoints.filter(
    (checkpoint) => checkpoint.governedBy === "rebaseline",
  );
  if (covered.length === 0) return null;
  const from = covered[0]?.dateKey;
  return `Desde el ${from} manda tu saldo re-anclado, no el cuadro: eso ya lo diste por bueno y no se toca. Lo que este cuadro reconstruye son los años anteriores.`;
}

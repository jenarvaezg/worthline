/**
 * La cuota vigente de una deuda amortizable (#1520): cuánto sale de la cuenta cada
 * mes por ella, hoy.
 *
 * Worthline modela el **saldo** (lo que se debe) y lo netea contra el capital en su
 * tramo. Lo que nunca ha tenido es el **flujo**: la cuota, que es la cifra con la que
 * se vive. Las dos superficies que contestan «¿de cuánto puedo vivir?» —la cobertura
 * del gasto y el gasto sostenible— la ignoraban porque el dominio no la sabía decir.
 *
 * Este módulo no la resta de nada (ADR 0099): la deja **medible**, que es lo que hace
 * falta para cruzarla contra el gasto declarado. Restarla además del capital sería el
 * doble conteo que el neteo del saldo ya evita.
 *
 * Es una lectura del cuadro, no un segundo simulador francés: la cuota que devuelve es
 * el `paymentMinor` del periodo que el mismo motor de la curva ya calculó, así que una
 * revisión de tipo o una amortización anticipada la mueven sin que aquí haya que
 * saberlo (ADR 0090, hermano de {@link accruedInterestAtDate}).
 */

import {
  type AmortizableBalanceAtDateInput,
  amortizationScheduleTrace,
} from "./amortization";

/** La cuota vigente de un plan en una fecha, y hasta cuándo pesa. */
export interface MonthlyDebtService {
  /** La cuota del próximo pago, en unidades menores enteras. */
  paymentMinor: number;
  /** La fecha de esa cuota (YYYY-MM-DD). */
  nextPaymentDate: string;
  /**
   * La última cuota del plan (YYYY-MM-DD): cuándo esta deuda deja de pesar. No se
   * usa para proyectar nada — worthline no tiene motor de flujos (ADR 0081) — pero
   * una cifra que dice «para siempre» sin saber su vencimiento es la trampa que la
   * opción de restarla habría creado.
   */
  finalPaymentDate: string;
}

/**
 * La cuota vigente en `targetDate`, o `null` cuando no hay ninguna corriendo: antes
 * del desembolso (la deuda todavía no existe) y en o después de la cuota que la
 * liquida (una amortización que cierra el préstamo también acaba aquí, porque el
 * cuadro se para en el primer periodo que cierra a cero).
 *
 * La vigente es la del ciclo que **cierra después** de la fecha, la misma convención
 * que {@link accruedInterestAtDate}: sobre la fecha de una cuota esa ya está pagada,
 * así que la que pesa es la siguiente. De ahí que el día del último pago devuelva
 * `null` — el saldo que la curva lee ahí es 0, y una cuota sobre una deuda liquidada
 * sería una tercera opinión sobre la misma deuda. En el tramo previo a la primera
 * cuota sí pesa: está contratada y se paga este mes.
 */
export function monthlyDebtServiceAtDate(
  input: AmortizableBalanceAtDateInput,
): MonthlyDebtService | null {
  const { plan, targetDate } = input;
  if (targetDate < plan.disbursementDate) {
    return null;
  }

  const trace = amortizationScheduleTrace(input);
  const next = trace.periods.find((period) => period.date > targetDate);
  const last = trace.periods.at(-1);
  if (next === undefined || last === undefined) {
    return null;
  }

  return {
    finalPaymentDate: last.date,
    nextPaymentDate: next.date,
    paymentMinor: next.paymentMinor,
  };
}

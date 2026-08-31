/**
 * La cuota vigente de cada deuda del espacio (#1520), leída una vez y compartida.
 *
 * El hecho vive en cuatro tablas —el plan, sus revisiones, sus amortizaciones
 * anticipadas y sus re-baselines— así que la regla («qué cuadro gobierna hoy y qué
 * cuota toca») la aplica el dominio (`debtServiceAtDate`) y esta función solo junta los
 * hechos. Mismo patrón que `readAmortizableStartByLiabilityId` (#1438): las lecturas
 * van solo por deuda AMORTIZABLE, que es la única con cuadro, y montan sobre el
 * `readDebtModel` que las tres superficies ya hacían.
 *
 * Las tres consumidoras —/objetivos (la glosa de sus dos tarjetas de €/mes), el hero
 * del home y el agent view (la señal de salud)— pasan por aquí, así que la cuota que
 * nombra una glosa y la que cita un aviso no pueden ser dos cifras distintas.
 */

import type { AgentViewReadStore } from "@worthline/db";
import { type DebtModel, debtServiceAtDate } from "@worthline/domain";

type DebtServiceReads = Pick<
  AgentViewReadStore,
  | "readAmortizationPlan"
  | "readBalanceRebaselines"
  | "readInterestRateRevisions"
  | "readEarlyRepayments"
>;

/**
 * Keyed by liability id, in minor units, at the liability's **100 %** — la
 * participación del ámbito la aplica `scopeMonthlyDebtService`, que es quien sabe qué
 * ámbito se está pintando. Una deuda sin cuota vigente (sin plan, ya vencida, o de un
 * modelo que no tiene cuadro) simplemente no aparece: `undefined` es «worthline no lo
 * sabe», que no es lo mismo que 0.
 */
export async function readMonthlyDebtServiceByLiabilityId(
  reads: DebtServiceReads,
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>,
  todayISO: string,
): Promise<Map<string, number>> {
  const amortizableIds = [...debtModelByLiabilityId.entries()]
    .filter(([, model]) => model === "amortizable")
    .map(([id]) => id);

  const entries = await Promise.all(
    amortizableIds.map(async (id) => {
      const [plan, rebaselines] = await Promise.all([
        reads.readAmortizationPlan(id),
        reads.readBalanceRebaselines(id),
      ]);
      // Las revisiones y las amortizaciones cuelgan del PLAN, no de la deuda: sin
      // plan no hay nada que pedir, y una deuda re-baselineada sin plan original
      // toma su cuadro del re-baseline.
      const [revisions, earlyRepayments] =
        plan === null
          ? [[], []]
          : await Promise.all([
              reads.readInterestRateRevisions(plan.id),
              reads.readEarlyRepayments(plan.id),
            ]);

      const service = debtServiceAtDate({
        balanceRebaselines: rebaselines,
        // Irrelevante aquí: la cuota sale del cuadro, nunca del saldo declarado. Se
        // pasa a 0 porque el input lo exige para el camino de la deuda SIN cuadro,
        // que es justo el que devuelve null.
        currentBalanceMinor: 0,
        debtModel: "amortizable",
        earlyRepayments,
        revisions,
        targetDate: todayISO,
        ...(plan === null
          ? {}
          : {
              plan: {
                annualInterestRate: plan.annualInterestRate,
                disbursementDate: plan.disbursementDate,
                firstPaymentDate: plan.firstPaymentDate,
                initialCapitalMinor: plan.initialCapitalMinor,
                termMonths: plan.termMonths,
              },
            }),
      });

      return service === null ? null : ([id, service.paymentMinor] as const);
    }),
  );

  return new Map(entries.filter((entry) => entry !== null));
}

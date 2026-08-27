/**
 * El único paso de crecimiento FIRE (#1597, ADR 0094).
 *
 * Antes había dos bucles: el escalar (`projectFire`) componía un número suelto
 * año a año y el del plan (`projectFireWithContributionPlan`) hacía lo mismo
 * sobre un mapa de cubos por holding. Dos bucles que tienen que dar la misma
 * cifra solo coinciden mientras alguien los mantiene a la par, y la equivalencia
 * únicamente estaba clavada para el caso «mensual constante + tasa uniforme».
 *
 * Aquí vive el bucle, una vez. Los tres modos son el MISMO paso con distintos
 * insumos:
 *
 * - **escalar**: un cubo (`AGGREGATE_BUCKET_ID`), tasa uniforme, la misma aportación
 *   anual todos los años.
 * - **plan**: un cubo por holding, la tasa de cada uno y el flujo de aportaciones
 *   repartido por año de proyección.
 * - **familia**: el escalar con DOS dianas — el número FIRE regular y el horizonte
 *   Fat — cronometradas sobre la misma trayectoria (#1537).
 *
 * El paso es, cada año: crecer los cubos, añadir la aportación del año, apuntar el
 * total. Ese orden es el contrato — la aportación entra a final de año y no compone
 * ese mismo año — y ahora solo se puede cambiar en un sitio.
 */

import { addHoldingContributions, growHoldingBuckets } from "./projection-buckets";

/**
 * El cubo del capital que no está repartido por holding: el capital de partida del
 * modo escalar y el agregado del modo plan cuando no llega un desglose. Con espacio
 * de nombres para que no choque con el id de un holding real.
 */
export const AGGREGATE_BUCKET_ID = "@worthline/fire-aggregate";

export interface FireTrajectoryPoint {
  year: number;
  eligibleMinor: number;
}

export interface FireGrowthStepperInput<TargetKey extends string> {
  /** Capital de partida por cubo (unidades menores). Un solo cubo en modo escalar. */
  startingBucketsMinor: ReadonlyMap<string, number>;
  /** Tasa real anual de cada cubo, ya con el desplazamiento del escenario dentro. */
  annualRateFor: (bucketId: string) => number;
  /** Aportaciones del año de proyección (1-based) por cubo destino; `undefined` = ninguna. */
  contributionsForYear?: (year: number) => ReadonlyMap<string, number> | undefined;
  /**
   * Las dianas a cronometrar, cada una con su nombre. El bucle para cuando el capital
   * alcanza la MÁS ALTA, así que una diana intermedia queda fechada sobre la misma
   * trayectoria y no sobre una segunda pasada.
   */
  targetsMinor: Readonly<Record<TargetKey, number>>;
  maxYears: number;
}

export interface FireGrowthRun<TargetKey extends string = string> {
  /** Un punto por año, del 0 (hoy) al año en que se para. Redondeado a unidades menores. */
  trajectory: FireTrajectoryPoint[];
  /**
   * Aportado ACUMULADO desde hoy hasta cada año: `[N]` es todo lo aportado en los años
   * 1..N, no lo del año N. `[0]` es 0.
   */
  contributedThroughYearMinor: number[];
  /** Primer año en que se alcanza cada diana, por su nombre; `null` = nunca. */
  yearsToTarget: Readonly<Record<TargetKey, number | null>>;
}

export function runFireGrowth<TargetKey extends string>(
  input: FireGrowthStepperInput<TargetKey>,
): FireGrowthRun<TargetKey> {
  const targets = Object.entries(input.targetsMinor) as [TargetKey, number][];
  if (targets.length === 0) {
    // Sin diana no hay «llegar», y el techo del bucle (`Math.max` de nada) sería
    // −Infinity: la corrida devolvería un solo punto y el llamador leería «ya está»
    // en vez de un error. El tipo no puede exigir un registro no vacío, así que lo
    // exige la puerta.
    throw new Error("runFireGrowth necesita al menos una diana en `targetsMinor`");
  }
  const buckets = new Map(input.startingBucketsMinor);
  let capital = totalBucketMinor(buckets);

  const trajectory: FireTrajectoryPoint[] = [
    { year: 0, eligibleMinor: Math.round(capital) },
  ];
  const contributedThroughYearMinor: number[] = [0];
  const yearsToTarget = {} as Record<TargetKey, number | null>;
  for (const [key, targetMinor] of targets) {
    yearsToTarget[key] = capital >= targetMinor ? 0 : null;
  }
  const stopTargetMinor = Math.max(...targets.map(([, targetMinor]) => targetMinor));
  let contributedMinor = 0;

  if (capital < stopTargetMinor) {
    for (let year = 1; year <= input.maxYears; year += 1) {
      growHoldingBuckets(buckets, input.annualRateFor);
      contributedMinor += addHoldingContributions(
        buckets,
        input.contributionsForYear?.(year),
      );
      capital = totalBucketMinor(buckets);

      trajectory.push({ year, eligibleMinor: Math.round(capital) });
      contributedThroughYearMinor.push(contributedMinor);

      for (const [key, targetMinor] of targets) {
        if (yearsToTarget[key] === null && capital >= targetMinor) {
          yearsToTarget[key] = year;
        }
      }

      if (capital >= stopTargetMinor) {
        break;
      }
    }
  }

  return { contributedThroughYearMinor, trajectory, yearsToTarget };
}

function totalBucketMinor(buckets: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const amount of buckets.values()) {
    total += amount;
  }
  return total;
}

/**
 * La edad a la que se llega a Coast FIRE (#1425, ADR 0079).
 *
 * La barra de /objetivos pinta un tick en Coast desde PRD #507, o sea un punto del
 * camino al que se llega en una fecha — y esa fecha no se calculaba en ninguna parte.
 * La única edad que la pantalla tenía era `fireAgeIfContributionsStop`, que responde
 * otra pregunta («si dejo de aportar hoy, ¿cuándo llego al número FIRE completo?»),
 * y al enseñarse bajo la etiqueta «Edad Coast» contradecía en silencio la premisa del
 * «Coast requerido» de al lado. Dos preguntas distintas compartiendo prefijo.
 *
 * Esta es la que faltaba: el primer momento en que el patrimonio proyectado **con las
 * aportaciones declaradas** cruza el Coast requerido. Y no trae fórmula nueva — reusa
 * las dos puertas que ya existen:
 *
 * - `calculateFire` para el requisito, así que la cifra contra la que se mide es
 *   exactamente la que la pantalla imprime encima.
 * - `projectFireFromContext` + `fractionalFireYear` para la trayectoria, la misma que
 *   fecha los niveles y el retraso de las metas.
 *
 * La trayectoria se proyecta **contra el propio Coast requerido**, no contra el número
 * FIRE: así `yearsToFire` ES el año del cruce y un FIRE que no llega en el horizonte no
 * borra una llegada a Coast que sí ocurre.
 *
 * Cuando la aportación tiende a 0 esta edad tiende a la de FIRE, y eso es correcto: el
 * concepto de Coast solo tiene holgura si ahorras.
 */

import {
  calculateFire,
  type FireContext,
  type FireResult,
  projectFireFromContext,
} from "./fire";
import type { FireProjection } from "./fire-projection";
import { fractionalFireYear, yearsUntilTarget } from "./fire-projection";
import { monthlySavingsCapacityForFire } from "./fire-savings-capacity";

export type FireCoastArrival =
  /** Ya está en Coast: ese caso no pide edad, pide un sello (`isAlreadyAtCoastFire`). */
  | { kind: "reached" }
  | {
      kind: "eta";
      /** Años fraccionarios hasta el cruce, a un decimal — para una glosa, no para la edad. */
      years: number;
      /**
       * La edad del año de proyección en que se cruza, a año entero — el `ageAtFire`
       * del escenario base, la misma convención que la edad de FIRE de al lado. Un
       * decimal en una edad proyectada a diez años finge precisión que no hay (#1425).
       */
      age: number;
    }
  /** Ni el retorno ni el ahorro declarado cruzan el requisito dentro del horizonte. */
  | { kind: "unreachable" };

/**
 * `null` cuando no hay Coast del que hablar: sin edad actual no hay horizonte que
 * descontar, y sin margen de composición hasta la edad objetivo —retorno ≤ 0, o edad
 * objetivo ya pasada— `calculateFire` no emite el bloque (ADR 0079), así que no hay
 * requisito que cruzar. Ojo: eso NO es un `unreachable`, que dice «con más ahorro
 * llegarías»; aquí no hay a dónde llegar.
 */
export function fireCoastArrival(
  context: FireContext,
  options?: {
    fireResult?: FireResult;
    /** Shared trajectory (#1537); Coast is interpolated on it instead of reprojected. */
    projection?: FireProjection;
  },
): FireCoastArrival | null {
  const { config, currency, eligibleMinor, realReturnUsed } = context;
  const currentAge = config.currentAge;

  // El requisito sale de la misma función que lo imprime en pantalla: si esto lo
  // volviera a dividir por su cuenta, la frontera «ya estoy» / «me faltan X años»
  // podría caer en un sitio distinto del que dice la cifra de al lado.
  const coast =
    options?.fireResult ?? calculateFire(config, eligibleMinor, currency, realReturnUsed);
  const requiredMinor = coast.coastFireRequired?.amountMinor;

  if (requiredMinor === undefined || currentAge === undefined) {
    return null;
  }

  if (coast.isAlreadyAtCoastFire === true) {
    return { kind: "reached" };
  }

  const projection =
    options?.projection ??
    projectFireFromContext(context, {
      // El escalar declarado y nada más (#1416, ADR 0074): la trayectoria que fecha
      // esta edad es la misma que pinta el gráfico de arriba.
      monthlyContributionMinor: monthlySavingsCapacityForFire(config),
      fireNumberMinor: requiredMinor,
    });
  const base = projection.scenarios.find((scenario) => scenario.label === "base")!;
  const yearsToCoast =
    options?.projection === undefined
      ? base.yearsToFire
      : yearsUntilTarget(base.trajectory, requiredMinor);
  const fraction = fractionalFireYear(base.trajectory, requiredMinor, yearsToCoast);

  if (fraction === null || yearsToCoast === null) {
    return { kind: "unreachable" };
  }

  return {
    // La edad NO se redondea aquí: es la que el propio escenario calculó
    // (`currentAge + yearsToFire`), la misma convención con la que la tarjeta de
    // proyección imprime «a los 99 años» justo al lado. Dos ETAs sacadas de una sola
    // trayectoria bajo dos convenciones de redondeo es exactamente lo que ADR 0077
    // vino a impedir — y con la interpolación en la glosa no se pierde precisión.
    age: options?.projection === undefined ? base.ageAtFire! : currentAge + yearsToCoast,
    kind: "eta",
    years: Math.round(fraction * 10) / 10,
  };
}

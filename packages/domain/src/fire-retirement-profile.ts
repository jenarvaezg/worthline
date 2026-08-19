/**
 * ¿Este plan es FIRE, o es una jubilación ordinaria? (#1428, ADR 0081.)
 *
 * Jorge tiene 63 años, se jubila a los 67, cobrará pensión pública y sus alquileres
 * ya cubren casi todo su gasto. La pantalla le decía que le faltaba el **31,5 %** y
 * que llegaría **a los 73**. Las dos cifras eran correctas y las dos le eran
 * inútiles, porque este señor no va a hacer FIRE — y no le hace falta.
 *
 * La salida NO es meter la pensión pública en el motor. FIRE es *Financial
 * Independence, **Retire Early***, y un motor con fechas de devengo y déficit por
 * tramos sería otro producto (un planificador de flujos de caja). Hay además dos
 * razones que cierran la puerta por dentro: con pensión a los 67 la tasa de retirada
 * deja de aplicar —un SWR es una regla para una cartera que debe durar 30–40 años sin
 * ingreso—, y los flujos recurrentes YA están dentro del ahorro, que es el residuo de
 * ingresos menos gastos, así que sumarlos como tercera entrada contaría dos veces el
 * mismo dinero (ADR 0054).
 *
 * Lo que sí se puede hacer es **detectar el perfil y cambiar la pregunta**: en vez de
 * «cuánto te falta», «cuánto puedes gastar sin mermar tu patrimonio»
 * (`fireSustainableSpending`). Este módulo decide cuándo la pantalla se atreve a
 * ofrecerlo.
 *
 * Y solo lo OFRECE. Autodetectar el perfil de alguien y anunciarle «tú no vas a hacer
 * FIRE» sienta fatal en cuanto la detección se equivoca, así que las señales proponen
 * y la declaración del usuario (`FireScopeConfig.retirementPlan`) decide — en los dos
 * sentidos, porque un «no» tiene que callar el ofrecimiento para siempre.
 *
 * Puro: no proyecta nada. La señal de «Regular inalcanzable» se lee del rail que el
 * llamante ya calculó (`fireLevels`), no de una segunda proyección — dos trayectorias
 * para la misma pregunta es exactamente lo que ADR 0077 vino a impedir.
 */

import type { FireContext } from "./fire";
import type { FireLevel } from "./fire-levels";

/** La declaración del usuario sobre su propio plan. */
export type FireRetirementPlan = "ordinary" | "early";

/**
 * La edad a partir de la cual jubilarse ya no es *early*, cuando el usuario no ha
 * dicho otra cosa. Neutro a propósito: la edad ordinaria depende del país y del año,
 * y este número es un dato editable, nunca normativa codificada.
 */
export const ORDINARY_RETIREMENT_AGE_DEFAULT = 65;

/** Por qué la app sospecha que el plan no es FIRE. Cada una se dice en pantalla. */
export type FireRetirementSignal =
  /** La edad objetivo llega a la edad ordinaria: no hay *early* en el plan. La más limpia. */
  | {
      kind: "target_age_is_ordinary";
      targetRetirementAge: number;
      ordinaryRetirementAge: number;
    }
  /**
   * Con el ahorro declarado, el nivel Regular no se cruza dentro del horizonte de la
   * proyección. Antes de #1416 esta señal no valía nada: la aportación proyectada eran
   * los 100 €/mes fantasma del plan de aportaciones, así que «inalcanzable» hablaba de
   * una cifra que el usuario nunca declaró.
   */
  | { kind: "regular_unreachable" };

/**
 * Qué pregunta lidera la pantalla:
 *
 * - `fire` — la de siempre («cuánto te falta»).
 * - `offer` — la de siempre, con un ofrecimiento discreto encima.
 * - `ordinary` — la del gasto sostenible, porque el usuario lo pidió.
 */
export type FireRetirementProfileState = "fire" | "offer" | "ordinary";

export interface FireRetirementProfile {
  state: FireRetirementProfileState;
  /** Las señales presentes, en orden estable — la copia las nombra todas. */
  signals: FireRetirementSignal[];
  /** Lo declarado, o `null` si el usuario no ha contestado. */
  declared: FireRetirementPlan | null;
  /** El umbral con el que se midió la señal de la edad, ya resuelto a su defecto. */
  ordinaryRetirementAge: number;
}

/** El umbral de edad ordinaria del ámbito, con su defecto resuelto en una sola puerta. */
export function ordinaryRetirementAgeForFire(
  config: Pick<FireContext["config"], "ordinaryRetirementAge">,
): number {
  return config.ordinaryRetirementAge ?? ORDINARY_RETIREMENT_AGE_DEFAULT;
}

export interface FireRetirementProfileInput {
  /** El contexto resuelto: de aquí sale la config (edades y declaración). */
  context: FireContext;
  /**
   * El rail de niveles YA calculado (`fireLevels`), del que se lee si Regular es
   * inalcanzable. `null` cuando el rail no se pinta (config degenerada): entonces esa
   * señal simplemente no existe, en vez de proyectarse aparte para responderla.
   */
  levels: readonly FireLevel[] | null;
}

export function fireRetirementProfile(
  input: FireRetirementProfileInput,
): FireRetirementProfile {
  const { config } = input.context;
  const ordinaryRetirementAge = ordinaryRetirementAgeForFire(config);

  const signals: FireRetirementSignal[] = [];

  // La edad objetivo DECLARADA, no la que el motor supone. `calculateFire` cae a 65
  // cuando no hay ninguna, y 65 es también el umbral por defecto: leer ese respaldo
  // como señal haría que la app le dijera «parece que tu plan es una jubilación
  // ordinaria» a todo el que no ha tocado el campo, citándole una edad que él nunca
  // escribió. Un valor por defecto no es una declaración (ADR 0074).
  const targetRetirementAge = config.targetRetirementAge;
  if (targetRetirementAge !== undefined && targetRetirementAge >= ordinaryRetirementAge) {
    signals.push({
      kind: "target_age_is_ordinary",
      ordinaryRetirementAge,
      targetRetirementAge,
    });
  }

  // Y el ahorro DECLARADO, por la misma razón: sin declaración la proyección aporta 0
  // (#1416), así que «con tu ahorro no llegas» sería cierto y a la vez injusto — habla
  // de una cifra que el usuario no ha rellenado todavía, no de su plan. Con un 0
  // declarado sí cuenta: eso es una respuesta.
  const regular = (input.levels ?? []).find((level) => level.key === "regular");
  if (
    regular?.eta.kind === "unreachable" &&
    config.monthlySavingsCapacityMinor !== undefined
  ) {
    signals.push({ kind: "regular_unreachable" });
  }

  const declared = config.retirementPlan ?? null;

  return {
    declared,
    ordinaryRetirementAge,
    signals,
    // La declaración manda en los dos sentidos: «ordinaria» no necesita señal
    // (nadie tiene que encajar en el patrón para pedirlo) y «FIRE» calla el
    // ofrecimiento aunque las señales sigan ahí — un «no» no se vuelve a preguntar.
    state:
      declared === "ordinary"
        ? "ordinary"
        : declared === "early"
          ? "fire"
          : signals.length > 0
            ? "offer"
            : "fire",
  };
}

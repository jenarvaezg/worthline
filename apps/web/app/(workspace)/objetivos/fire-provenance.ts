/**
 * De dónde sale la edad de referencia del FIRE — el discriminante, no las palabras.
 *
 * Dos superficies de la misma pantalla cuentan esta procedencia con voces
 * distintas: la fila de solo lectura del formulario de supuestos (#1450), que
 * dispone de una línea entera, y la glosa del pliegue «¿De dónde salen estos
 * años?» (#1426), que dispone de media. Lo que NO pueden es discrepar sobre el
 * estado: que una diga «derivada» donde la otra dice «a mano» convierte la
 * pantalla auditable en dos pantallas que se contradicen.
 *
 * Así que el estado se decide aquí una vez y cada superficie lo redacta. La
 * tercera rama es la que se perdía al preguntar solo «¿hay `ageSource`?»: un
 * scope sin fecha de nacimiento y sin edad heredada no tiene una edad configurada
 * a mano — no tiene ninguna, y decir lo contrario manda al usuario a buscar un
 * campo que no existe.
 */

import type { FireAgeSource, FireScopeConfig } from "@worthline/domain";

export type FireAgeProvenance =
  /** Derivada del año de nacimiento del miembro (#1415, ADR 0073). */
  | { kind: "derived"; age: number; birthYear: number }
  /** Escalar heredado de una config anterior a #1415: no se actualiza solo. */
  | { kind: "frozen"; age: number }
  /** Ni fecha de nacimiento ni escalar heredado: no hay edad que enseñar. */
  | { kind: "absent" };

export function fireAgeProvenance(
  ageSource: FireAgeSource | null,
  config: FireScopeConfig | null | undefined,
): FireAgeProvenance {
  if (ageSource !== null) {
    return { age: ageSource.age, birthYear: ageSource.birthYear, kind: "derived" };
  }
  const frozen = config?.currentAge;
  return frozen === undefined ? { kind: "absent" } : { age: frozen, kind: "frozen" };
}

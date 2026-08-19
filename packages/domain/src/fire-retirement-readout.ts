/**
 * Las dos cosas que la capa de #1428 necesita, emparejadas (ADR 0081).
 *
 * `fireRetirementProfile` y `fireSustainableSpending` se leen SIEMPRE juntas —el perfil
 * decide qué pregunta lidera, el gasto sostenible es la respuesta— y tres superficies
 * las piden: el estado de /objetivos, la isla que previsualiza al teclear y
 * `get_fire_context`. Escritas por separado en cada sitio, el invariante que las une
 * («el perfil se mide contra el MISMO rail que la pantalla pinta, no contra una segunda
 * proyección») quedaba sostenido por un comentario repetido tres veces.
 *
 * Aquí queda sostenido por la firma: quien quiera la lectura pasa el resultado FIRE y su
 * rail, y recibe las dos piezas resueltas de una vez.
 */

import type { ScopeFireResult } from "./fire";
import type { FireLevel } from "./fire-levels";
import type { FireRetirementProfile } from "./fire-retirement-profile";
import { fireRetirementProfile } from "./fire-retirement-profile";
import type { FireSustainableSpending } from "./fire-sustainable-spending";
import { fireSustainableSpending } from "./fire-sustainable-spending";

export interface FireRetirementReadout {
  /** ¿FIRE, ofrecimiento o jubilación ordinaria? */
  profile: FireRetirementProfile;
  /**
   * «¿Cuánto puedo gastar sin mermar mi patrimonio?». Se calcula SIEMPRE que haya con
   * qué, sea cual sea el perfil: es una cifra honesta para cualquiera, y el perfil solo
   * decide si es el titular. `null` cuando no hay tasa de retirada con la que dividir.
   */
  spending: FireSustainableSpending | null;
}

export interface FireRetirementReadoutInput {
  result: ScopeFireResult;
  /** El rail YA calculado (`fireLevels`), del que sale la señal de «Regular inalcanzable». */
  levels: readonly FireLevel[] | null;
}

export function fireRetirementReadout(
  input: FireRetirementReadoutInput,
): FireRetirementReadout {
  return {
    profile: fireRetirementProfile({
      context: input.result.context,
      levels: input.levels,
    }),
    spending: fireSustainableSpending(input.result),
  };
}

/**
 * «Desde cuándo puedo tocarlo» — la fecha de disponibilidad declarada (#1528, ADR 0100).
 *
 * El escalón «A plazo» es, desde ADR 0013, *bloqueado hasta una fecha*, y esa fecha no
 * existía en el modelo: el peldaño decía que había un plazo y no decía cuál. Por eso un
 * plan de pensiones se trataba como un bloque todo-o-nada, y las dos únicas salidas
 * posibles eran igual de falsas — contarlo entero como capital que se puede gastar a
 * plazos, o sacarlo entero y esconder dinero que ya se puede rescatar.
 *
 * Tres decisiones hacen honesta esta superficie:
 *
 * 1. **Se pide una fecha, nunca un importe.** Un «disponible hoy: 4.979 €» caduca cada
 *    año y nadie lo revalida (ADR 0074, la avería de #1415). Lo disponible es una
 *    lectura, no un dato.
 * 2. **La lectura se enseña al lado.** Los años que faltan se derivan del mismo día
 *    contra el que se calcula el reparto, así que la frase de aquí y la cifra de
 *    /objetivos no pueden contar historias distintas (ADR 0077).
 * 3. **El hueco se dice en voz alta.** Un holding a plazo SIN fecha no es un cero: el
 *    reparto lo cuenta como disponible desde el primer año, y quien no lo sepa no puede
 *    corregirlo. Callarlo sería la ilusión de liquidez que #1447 vino a matar.
 *
 * No hay `min` en el campo: una fecha pasada es una declaración legítima («esto ya se
 * podía rescatar desde 2024») y el motor la lee como capital disponible hoy.
 */

import {
  AVAILABLE_FROM_HELP,
  AVAILABLE_FROM_UNDECLARED_NOTE,
  type FormErrorContext,
} from "@web/intake";
import { setHoldingAvailableFromAction } from "@web/patrimonio/actions";
import { formatDateKeyEs, yearsUntilAvailable } from "@worthline/domain";

export function AvailabilitySection({
  assetId,
  availableFrom,
  currentUrl,
  formError,
  supersededByLots,
  today,
}: {
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  assetId: string;
  /** La fecha declarada, o null cuando nadie la ha dicho. */
  availableFrom: string | null;
  /** The holding's own public `wl_hld_…` URL, where the form returns. */
  currentUrl: string;
  formError: FormErrorContext | null;
  /**
   * Si el holding ha declarado lotes (#1676), que mandan sobre esta fecha. Se dice en
   * voz alta: un campo que sigue guardando y ya no decide nada es peor que no estar,
   * porque el dueño cree haber declarado algo que el motor no está leyendo.
   */
  supersededByLots: boolean;
  /** Hoy, como clave ISO. El MISMO reloj con el que el motor resuelve la fecha. */
  today: string;
}) {
  const values = formError?.formId === "availableFrom" ? formError.values : {};
  // Derivada, nunca guardada: los años que faltan salen de la fecha y del día de
  // lectura, exactamente como los saca el reparto del gasto sostenible.
  const yearsUntil =
    availableFrom === null ? null : yearsUntilAvailable(availableFrom, today);

  return (
    <section className="holdingAvailability" aria-labelledby="availability-title">
      <h3 id="availability-title">Desde cuándo puedes tocarlo</h3>

      <form action={setHoldingAvailableFromAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={assetId} />
        <label>
          Disponible desde
          <input
            aria-label="Fecha desde la que el capital está disponible"
            defaultValue={values["availableFrom"] ?? availableFrom ?? ""}
            name="availableFrom"
            type="date"
          />
        </label>
        <p className="infoNote">{AVAILABLE_FROM_HELP}</p>
        <button type="submit">Guardar fecha</button>
      </form>

      {supersededByLots ? (
        <p className="infoNote">
          Has declarado lotes de aportación más abajo, y mandan ellos: esta fecha se
          guarda pero no está decidiendo nada. Quita todos los lotes para que vuelva a
          mandar.
        </p>
      ) : availableFrom === null ? (
        <p className="infoNote">{AVAILABLE_FROM_UNDECLARED_NOTE}</p>
      ) : (
        <p className="availabilityReadout">
          {/* `<output>` y no un `<strong>`: esto ES el resultado de un cálculo, y su
              rol es el que acepta el nombre accesible que un lector de pantalla
              necesita oír junto a la frase (biome a11y). */}
          <output aria-label="Disponibilidad derivada de la fecha declarada">
            {yearsUntil === 0
              ? `Disponible desde el ${formatDateKeyEs(availableFrom)}: ya se puede tocar.`
              : yearsUntil === 1
                ? `Disponible el ${formatDateKeyEs(availableFrom)}: dentro de 1 año.`
                : `Disponible el ${formatDateKeyEs(availableFrom)}: dentro de ${yearsUntil} años.`}
          </output>
        </p>
      )}
    </section>
  );
}

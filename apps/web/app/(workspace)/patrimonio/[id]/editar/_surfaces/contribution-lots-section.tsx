/**
 * La escalera de un plan de pensiones (#1676, fase 2 de #1528).
 *
 * La fase 1 pregunta «¿desde cuándo puedes tocarlo?» una vez, y eso basta para un
 * depósito o para un plan bloqueado hasta los 65. Un plan de pensiones en curso casi
 * nunca es eso: desde 2025 se rescatan las aportaciones con más de diez años, así que
 * es **dos cosas a la vez** — un tramo ya disponible y otro que todavía no. Con una
 * sola fecha, el partícipe tiene que declarar la del tramo más conservador y esconder
 * lo que ya podría tocar.
 *
 * Tres decisiones sostienen esta superficie:
 *
 * 1. **Lo que se declara es fecha e importe, nunca «disponible hoy».** Esa cifra caduca
 *    cada año y nadie la revalida (ADR 0074). La escalera no caduca; lo disponible se
 *    deriva contra el día de quien mira.
 * 2. **La ventana de los diez años se SUGIERE, no se aplica.** Cuando el capital entró
 *    por movilización y trae antigüedad heredada (#1518), la fecha viene precargada y
 *    la ficha dice de dónde sale. El dueño confirma o corrige, y lo que se guarda es su
 *    declaración: el motor no sabe qué es un año fiscal ni cuántos hacen falta.
 * 3. **El hueco se dice en voz alta.** Lo que los lotes no cubren no se reparte como
 *    disponible: se cuenta como capital a plazo sin fecha, y aquí se nombra en vez de
 *    dejar que el usuario descubra la diferencia en otra pantalla.
 *
 * Lista + alta + baja, sin JS de cliente: cada fila es su propio formulario, que es lo
 * que deja borrar un lote sin depender de un cliente que quizá no ha cargado.
 */

import {
  CONTRIBUTION_LOT_HELP,
  CONTRIBUTION_LOT_PARTIAL_NOTE,
  type FormErrorContext,
} from "@web/intake";
import {
  addContributionLotAction,
  removeContributionLotAction,
} from "@web/patrimonio/actions";
import { formatDateKeyEs, resolveHoldingLots } from "@worthline/domain";

export interface DeclaredLotRow {
  id: string;
  availableFrom: string;
  amountMinor: number;
}

export function ContributionLotsSection({
  assetId,
  currentUrl,
  formatMoney,
  formError,
  holdingMinor,
  lots,
  suggestedAvailableFrom,
  today,
}: {
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  assetId: string;
  /** The holding's own public `wl_hld_…` URL, where the forms return. */
  currentUrl: string;
  formatMoney: (amountMinor: number) => string;
  formError: FormErrorContext | null;
  /** Lo que vale el holding entero — el techo contra el que se lee la escalera. */
  holdingMinor: number;
  /** Los lotes declarados, de antes a después. */
  lots: DeclaredLotRow[];
  /**
   * La fecha que la antigüedad heredada sugiere (#1518 + la ventana normativa), o null
   * cuando no hay antigüedad declarada — que es el caso por defecto.
   */
  suggestedAvailableFrom: string | null;
  /** Hoy, como clave ISO. El MISMO reloj con el que el motor resuelve la escalera. */
  today: string;
}) {
  const values = formError?.formId === "contributionLot" ? formError.values : {};

  const declaredMinor = lots.reduce((sum, lot) => sum + lot.amountMinor, 0);
  // El MISMO motor que resuelve la escalera en /objetivos, no una re-derivación con la
  // misma forma: si una frase cita una aritmética, cita la que produjo la cifra (ADR
  // 0077). Reimplementarla aquí coincidiría hoy y se separaría en cuanto una de las
  // dos se tocara, y el usuario leería dos verdades sobre el mismo plan.
  const resolved = resolveHoldingLots({
    availableFrom: undefined,
    holdingMinor,
    lots,
    todayISO: today,
  });
  const lockedMinor = resolved.declared.reduce(
    (sum, tranche) => sum + tranche.amountMinor,
    0,
  );
  const availableNowMinor = holdingMinor - lockedMinor - resolved.undeclaredMinor;
  const uncoveredMinor = resolved.undeclaredMinor;

  return (
    <section aria-labelledby="lots-title" className="holdingLots">
      <h3 id="lots-title">Tus lotes de aportación</h3>
      <p className="infoNote">{CONTRIBUTION_LOT_HELP}</p>

      {lots.length > 0 ? (
        <>
          <ul aria-label="Lotes de aportación declarados" className="lotList">
            {lots.map((lot) => (
              <li className="lotRow" key={lot.id}>
                <span className="lotDate">
                  {lot.availableFrom <= today
                    ? `Rescatable desde el ${formatDateKeyEs(lot.availableFrom)}`
                    : `Rescatable el ${formatDateKeyEs(lot.availableFrom)}`}
                </span>
                <strong>{formatMoney(lot.amountMinor)}</strong>
                <form action={removeContributionLotAction}>
                  <input name="currentUrl" type="hidden" value={currentUrl} />
                  <input name="id" type="hidden" value={assetId} />
                  <input name="lotId" type="hidden" value={lot.id} />
                  <button type="submit">Quitar</button>
                </form>
              </li>
            ))}
          </ul>

          {/* La lectura, al lado de la declaración: es el resultado de un cálculo, y
              sale del mismo día contra el que el reparto resuelve la escalera. */}
          <p className="availabilityReadout">
            <output aria-label="Capital ya rescatable según los lotes declarados">
              De {formatMoney(holdingMinor)}, ya puedes rescatar{" "}
              {formatMoney(availableNowMinor)}.
            </output>
          </p>

          {uncoveredMinor > 0 ? (
            <p className="infoNote">
              Tus lotes suman {formatMoney(declaredMinor)} y el plan vale{" "}
              {formatMoney(holdingMinor)}: quedan {formatMoney(uncoveredMinor)} sin
              fechar. {CONTRIBUTION_LOT_PARTIAL_NOTE}
            </p>
          ) : null}
        </>
      ) : (
        <p className="infoNote">
          Todavía no has declarado ningún lote, así que este plan se comporta como un
          bloque: manda la fecha única de arriba.
        </p>
      )}

      <form action={addContributionLotAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={assetId} />
        <label>
          Rescatable desde
          <input
            aria-label="Fecha desde la que este lote se puede rescatar"
            defaultValue={values["lotAvailableFrom"] ?? suggestedAvailableFrom ?? ""}
            name="lotAvailableFrom"
            type="date"
          />
        </label>
        <label>
          Importe del lote
          <input
            aria-label="Capital aportado en este lote"
            defaultValue={values["lotAmount"] ?? ""}
            inputMode="decimal"
            name="lotAmount"
            type="text"
          />
        </label>
        {/* La sugerencia se dice, no se aplica a escondidas: un campo precargado que
            no explica de dónde sale es una cifra que el usuario no puede auditar. */}
        {suggestedAvailableFrom !== null ? (
          <p className="infoNote">
            Te proponemos el {formatDateKeyEs(suggestedAvailableFrom)}: son diez años
            desde la antigüedad que declaraste al registrar el traspaso. Confírmalo o
            corrígelo con tu extracto delante.
          </p>
        ) : null}
        <button type="submit">Añadir lote</button>
      </form>
    </section>
  );
}

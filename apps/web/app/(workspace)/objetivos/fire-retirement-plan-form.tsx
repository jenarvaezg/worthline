/**
 * El botón que declara (o desdeclara) que el plan es una jubilación ordinaria (#1428).
 *
 * Tres sitios lo usan —las dos respuestas del ofrecimiento y la vuelta atrás junto al
 * porcentaje degradado— y los tres mandan lo mismo: el ámbito, la URL de vuelta y qué
 * plan. Escrito tres veces serían tres formularios con los mismos `hidden` y tres
 * ocasiones de olvidar uno.
 *
 * Un formulario por respuesta, no uno con dos botones: así `useFormStatus` sabe cuál se
 * pulsó y solo ese anuncia que está guardando (interaction-patterns §4 — una mutación
 * sin acuse en vuelo se lee como una app congelada).
 */

import { PendingSubmit } from "@web/pending-submit";
import type { FireRetirementPlan } from "@worthline/domain";
import { setRetirementPlanAction } from "./fire-config-actions";

export interface FireRetirementPlanFormProps {
  /** El plan que este botón declara. */
  plan: FireRetirementPlan;
  /** Lo que dice el botón. */
  label: string;
  /** Clase del botón, para distinguir la respuesta que no cambia nada. */
  buttonClassName?: string;
  currentUrl: string;
  scopeId: string;
}

export function FireRetirementPlanForm({
  buttonClassName,
  currentUrl,
  label,
  plan,
  scopeId,
}: FireRetirementPlanFormProps) {
  return (
    <form action={setRetirementPlanAction} className="fireRetirementPlanForm">
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="retirementPlan" type="hidden" value={plan} />
      <input name="scopeId" type="hidden" value={scopeId} />
      <PendingSubmit className={buttonClassName ?? "btnSmall"} pendingLabel="Guardando…">
        {label}
      </PendingSubmit>
    </form>
  );
}

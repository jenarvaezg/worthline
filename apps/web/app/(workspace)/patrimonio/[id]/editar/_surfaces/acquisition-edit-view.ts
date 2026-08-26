import type { AcquisitionAnchorEditPreview } from "@worthline/db";
import type {
  HousingCurveComparisonPoint,
  HousingCurveDateRole,
} from "@worthline/domain";
import { formatDateKeyEs } from "@worthline/domain";

/**
 * The sentences the acquisition preview says out loud (#1562,
 * interaction-patterns §7). Pure: the island renders what these return and holds
 * no copy of its own.
 *
 * The confirm button is never disabled by what the preview measured (ADR 0070
 * §4). Rewriting 22 years of curve is the user's call — the only thing the door
 * owes them is the size of the rewrite, in the verb of the button they are about
 * to press.
 */

export type MinorFormatter = (minor: number) => string;

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Whether the edit would change the stored acquisition at all. */
export function acquisitionEditChangesSomething(
  preview: AcquisitionAnchorEditPreview,
): boolean {
  return preview.dateChanged || preview.valueChanged;
}

/** Snapshots the rewrite touches in total — recalculated plus newly minted. */
export function acquisitionSnapshotCount(preview: AcquisitionAnchorEditPreview): number {
  return preview.snapshotsRecalculated + preview.snapshotsGenerated;
}

/** How much history the rewrite moves, and from when. */
export function acquisitionRewriteSentence(
  preview: AcquisitionAnchorEditPreview,
): string {
  if (!acquisitionEditChangesSomething(preview)) {
    return "La fecha y el precio son los que ya están guardados: guardar no cambia nada.";
  }
  if (acquisitionSnapshotCount(preview) === 0) {
    return "Todavía no hay histórico que reescribir: la curva se recalculará sola en la próxima captura diaria.";
  }
  const minted = count(preview.snapshotsGenerated, "snapshot nuevo", "snapshots nuevos");
  const since = `desde el ${formatDateKeyEs(preview.fromDateKey)}`;
  if (preview.snapshotsRecalculated === 0) {
    // Nothing to re-derive, only history to mint: saying «reescribirá 0» would be
    // a number where there is none.
    return `Guardar creará ${minted} en la fecha de adquisición, ${since}.`;
  }
  const generated =
    preview.snapshotsGenerated > 0
      ? ` Además creará ${minted} en la fecha de adquisición.`
      : "";
  return `Guardar reescribirá ${count(
    preview.snapshotsRecalculated,
    "snapshot del histórico",
    "snapshots del histórico",
  )}, ${since}.${generated}`;
}

/** The verb of the confirm button: what pressing it does, never «Confirmar». */
export function acquisitionConfirmLabel(preview: AcquisitionAnchorEditPreview): string {
  if (!acquisitionEditChangesSomething(preview)) {
    return "Guardar adquisición";
  }
  const total = acquisitionSnapshotCount(preview);
  if (total === 0) {
    return "Guardar adquisición";
  }
  return `Reescribir ${count(total, "snapshot", "snapshots")} y guardar`;
}

/** What a compared date is, for the before/after table's row header. */
export function acquisitionDateRoleLabel(
  role: HousingCurveDateRole,
  preview: AcquisitionAnchorEditPreview,
): string {
  switch (role) {
    case "acquisition_current":
      return "Adquisición (fecha actual)";
    case "acquisition_new":
      return preview.dateChanged ? "Adquisición (fecha nueva)" : "Adquisición";
    case "appraisal":
      return "Tasación";
    case "improvement":
      return "Mejora";
    case "curve":
      return "Curva (tramo que se redibuja)";
    case "today":
      return "Hoy";
  }
}

/**
 * The date the curve moves the most, or null when the edit moves no date. The
 * table shows every compared date; this is the one sentence that names the size
 * of the change without the reader having to scan it.
 */
export function acquisitionWorstMove(
  preview: AcquisitionAnchorEditPreview,
): HousingCurveComparisonPoint | null {
  let worst: HousingCurveComparisonPoint | null = null;
  for (const point of preview.points) {
    if (point.deltaMinor === 0) continue;
    if (worst === null || Math.abs(point.deltaMinor) > Math.abs(worst.deltaMinor)) {
      worst = point;
    }
  }
  return worst;
}

/** «El mayor cambio es el 19/05/2004: 150.253,03 € pasa a 160.000,00 €.» */
export function acquisitionWorstMoveSentence(
  preview: AcquisitionAnchorEditPreview,
  format: MinorFormatter,
): string | null {
  const worst = acquisitionWorstMove(preview);
  if (worst === null) return null;
  return `El mayor cambio es el ${formatDateKeyEs(worst.dateKey)}: ${format(
    worst.beforeMinor,
  )} pasa a ${format(worst.afterMinor)}.`;
}

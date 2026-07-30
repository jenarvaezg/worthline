/**
 * The write frontier of a connected source, enforced in CODE (uso real 2026-07-30).
 *
 * A holding materialized by Binance/Numista is owned by the sync: its value is
 * derived from mirrored positions, never hand-set. Until now the only thing
 * stopping the assistant from planting a `valuation_anchor` on one was a sentence
 * in the tool descriptions — and the free pool's model walked straight past it
 * (it declared a Numista collection «no se actualiza automáticamente» and prepared
 * a `declare_value`). The reconcile already fenced these holdings out in code
 * (#1108); corrections and bajas did not. Lesson of #1326: a boundary that lives
 * in a prompt is not a boundary.
 *
 * The rejection is an honest, actionable Spanish error in the same
 * `{ ok: false, error }` shape as every other builder refusal — it names the
 * source and points at the one path that does work.
 */

import { connectedSourceByAssetId } from "@web/agent-view/connected-source-provenance";
import type { AgentViewHoldingProvenance } from "@web/agent-view/contract";
import type { AgentViewReadStore } from "@worthline/db";

/** The narrow read a write guard needs: who materializes which asset. */
export type ConnectedSourceProvenanceReads = Pick<
  AgentViewReadStore,
  "readConnectedSources"
>;

/**
 * Every asset id a connected source materializes, mapped to the source's mark —
 * the same derivation the agent view stamps on each holding row, so a guard and a
 * read can never disagree about who owns a value.
 */
export async function readConnectedSourceOwners(
  agentView: ConnectedSourceProvenanceReads,
): Promise<ReadonlyMap<string, AgentViewHoldingProvenance>> {
  return connectedSourceByAssetId(await agentView.readConnectedSources());
}

/**
 * Why a declared figure cannot land on a sync-owned holding, and what does work.
 * Names the source so the user recognizes it in Ajustes.
 */
export function connectedSourceValueRejection(
  owner: AgentViewHoldingProvenance,
  holdingName: string,
): string {
  return (
    `«${holdingName}» la mantiene la fuente conectada «${owner.label}» (${owner.adapter}): ` +
    "su valor lo escribe la sincronización a partir de las posiciones espejadas, así que no " +
    "puedo declararlo ni corregirlo a mano (lo sobrescribiría el siguiente sync). " +
    "Para ponerla al día, sincroniza la fuente en Ajustes (/ajustes); si lo que está mal es " +
    "el mapeo o el catálogo de la fuente, se arregla ahí. Si de verdad quieres llevar esta " +
    "posición a mano, desconecta la fuente en Ajustes conservando sus valores: entonces pasa " +
    "a ser un holding manual y sí puedo corregirlo."
  );
}

/** Why a sync-owned holding cannot be sent to the papelera, and what does work. */
export function connectedSourceRemovalRejection(
  owner: AgentViewHoldingProvenance,
  holdingName: string,
): string {
  return (
    `«${holdingName}» la materializa la fuente conectada «${owner.label}» (${owner.adapter}), ` +
    "así que no puedo darla de baja desde aquí: el sync la volvería a proyectar. " +
    "Para quitarla, desconecta la fuente en Ajustes (/ajustes) — puedes conservar sus valores " +
    "como holding manual y darlo de baja después, o eliminar la fuente y sus posiciones."
  );
}

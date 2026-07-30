/**
 * Where a holding COMES FROM, in one place. A holding materialized by a connected
 * source (Binance, Numista…) is owned by the sync: nothing else may write its
 * value. The fact was already in the agent view — but only as a separate
 * `connectedSources` block listing which holdings each source projects, and
 * joining two blocks is exactly what a small model does not do (the free pool's
 * flash-lite told a user his Numista collection «no se actualiza automáticamente»
 * and offered to declare its value by hand).
 *
 * So the mark travels ON the row, and this module is the single place that derives
 * it from `readConnectedSources()` — the same source of truth the
 * `connectedSources` block is built from, never a second query.
 */

import type { AgentViewConnectedSource } from "@worthline/db";
import type { AgentViewHoldingProvenance } from "./contract";

/**
 * Index every asset id a connected source materializes (one per occupied rung) by
 * the source's identity mark. An asset absent from the map is hand-maintained.
 */
export function connectedSourceByAssetId(
  sources: readonly AgentViewConnectedSource[],
): ReadonlyMap<string, AgentViewHoldingProvenance> {
  const byAssetId = new Map<string, AgentViewHoldingProvenance>();

  for (const source of sources) {
    for (const assetId of source.assetIds) {
      byAssetId.set(assetId, { adapter: source.adapter, label: source.label });
    }
  }

  return byAssetId;
}

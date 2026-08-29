/**
 * A connection whose last fetch failed, or whose sync has simply gone stale
 * (PRD #654 S1).
 */

import {
  type DataQualityCollector,
  type DataQualitySignal,
  dateOnly,
  signalNaturalKey,
} from "./data-quality-collector";
import {
  type DataQualityConnectedSource,
  type DataQualitySourceHealthInput,
  sourceFreshnessStatus,
  sourceIsInScope,
} from "./data-quality-connected-source";

export const collectSourceFreshnessSignals: DataQualityCollector<
  DataQualitySourceHealthInput
> = (input) => {
  const signals: DataQualitySignal[] = [];

  for (const source of input.connectedSources) {
    if (!sourceIsInScope(source, input.ownedAssetIds)) {
      continue;
    }

    const freshness = input.sourceFreshnessBySourceId.get(source.id) ?? null;
    const status = sourceFreshnessStatus(source, freshness);
    if (status === null) {
      continue;
    }

    signals.push(sourceFreshnessSignal(source, status === "failed", freshness));
  }

  return signals;
};

function sourceFreshnessSignal(
  source: DataQualityConnectedSource,
  isFailed: boolean,
  freshness: { fetchedAt: string } | null,
): DataQualitySignal {
  return {
    affected: {
      id: source.id,
      label: source.label,
      object: "connected_source",
    },
    category: "source_freshness",
    code: isFailed ? "FAILED_SOURCE_SYNC" : "STALE_SOURCE_SYNC",
    fixable: false,
    label: isFailed
      ? `La última sincronización de "${source.label}" falló.`
      : `La sincronización de "${source.label}" está desactualizada.`,
    naturalKey: signalNaturalKey(
      "source_freshness",
      isFailed ? "FAILED_SOURCE_SYNC" : "STALE_SOURCE_SYNC",
      source.id,
    ),
    ...(freshness === null ? {} : { observedDate: dateOnly(freshness.fetchedAt) }),
    severity: isFailed ? "high" : "medium",
  };
}

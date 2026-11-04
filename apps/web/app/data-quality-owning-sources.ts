import type { AgentViewReadStore } from "@worthline/db";
import type { DataQualityOwningSourceStanding } from "@worthline/domain";

/**
 * The standing of every connection that owns its holdings (MyInvestor, #1885), for
 * the data-health input: the home and the agent view both read it here, so the two
 * hand the engine the same map. A mirroring source has none and is left out, which
 * is what keeps it on the generic count of failed runs. It is told apart by the row
 * already read (it has a mirror asset), so it costs no query on the home's GET; a
 * source that owns its holdings costs one.
 */
export async function readOwningSourceStandings(
  store: Pick<AgentViewReadStore, "readOwningSourceStanding">,
  sources: readonly { id: string; assetId: string | null }[],
): Promise<Array<readonly [string, DataQualityOwningSourceStanding]>> {
  const entries = await Promise.all(
    sources
      .filter((source) => source.assetId === null)
      .map(
        async (source) =>
          [source.id, await store.readOwningSourceStanding(source.id)] as const,
      ),
  );
  return entries.flatMap(([id, standing]) =>
    standing === null ? [] : [[id, standing] as const],
  );
}

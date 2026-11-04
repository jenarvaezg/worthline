import type { AgentViewReadStore } from "@worthline/db";
import type { DataQualityOwningSourceStanding } from "@worthline/domain";

/**
 * The standing of every connection that owns its holdings (MyInvestor, #1885), for
 * the data-health input: the home and the agent view both read it here, so the two
 * hand the engine the same map. A mirroring source has none and is left out, which
 * is what keeps it on the generic count of failed runs.
 */
export async function readOwningSourceStandings(
  store: Pick<AgentViewReadStore, "readOwningSourceStanding">,
  sources: readonly { id: string }[],
): Promise<Array<readonly [string, DataQualityOwningSourceStanding]>> {
  const entries = await Promise.all(
    sources.map(
      async (source) =>
        [source.id, await store.readOwningSourceStanding(source.id)] as const,
    ),
  );
  return entries.flatMap(([id, standing]) =>
    standing === null ? [] : [[id, standing] as const],
  );
}

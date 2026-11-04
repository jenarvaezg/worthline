/**
 * The read behind what /objetivos says of the holdings a source owns (#1886): which
 * sources own their holdings' ledgers (MyInvestor, ADR 0115) and the contributions
 * each linked holding has scheduled there, from the stored read the last pass
 * refreshed — never from MyInvestor itself.
 *
 * One `listSources` for every workspace; the stored read and the links only when a
 * MyInvestor connection exists.
 */

import type { WorthlineStore } from "@web/store";
import { isMirroredSourceAdapter } from "@worthline/domain";
import {
  type MyInvestorSchedule,
  myInvestorSchedulesByAsset,
} from "./myinvestor-contributions";
import { parseMyInvestorDiscovery } from "./myinvestor-discovery";

export interface OwnedSchedules {
  /** The sources that own their holdings' ledgers. */
  owningSourceIds: Set<string>;
  /** Each linked holding's scheduled contributions; absent when it has none. */
  schedulesByAsset: Map<string, MyInvestorSchedule[]>;
  /** The day of the read each holding's schedules come from. */
  readOnByAsset: Map<string, string>;
}

type Store = {
  connectedSources: Pick<
    WorthlineStore["connectedSources"],
    "listSources" | "readDiscovery" | "readLinks"
  >;
};

/** The sources that own their holdings' ledgers, by id. */
export async function readOwningSourceIds(store: {
  connectedSources: Pick<WorthlineStore["connectedSources"], "listSources">;
}): Promise<Set<string>> {
  const sources = await store.connectedSources.listSources();
  return new Set(
    sources.filter((source) => !isMirroredSourceAdapter(source.adapter)).map((s) => s.id),
  );
}

export async function readOwnedSchedules(
  store: Store,
  today: string,
): Promise<OwnedSchedules> {
  const sources = await store.connectedSources.listSources();
  const owning = sources.filter((source) => !isMirroredSourceAdapter(source.adapter));
  const schedulesByAsset = new Map<string, MyInvestorSchedule[]>();
  const readOnByAsset = new Map<string, string>();
  const reads = await Promise.all(
    owning
      .filter((source) => source.adapter === "myinvestor")
      .map((source) =>
        Promise.all([
          store.connectedSources.readDiscovery(source.id),
          store.connectedSources.readLinks(source.id),
        ]),
      ),
  );
  for (const [row, links] of reads) {
    const discovery = row ? parseMyInvestorDiscovery(row.payloadJson) : null;
    if (!discovery) continue;
    for (const [assetId, schedules] of myInvestorSchedulesByAsset(
      discovery,
      links,
      today,
    )) {
      schedulesByAsset.set(assetId, schedules);
      readOnByAsset.set(assetId, discovery.readOn);
    }
  }
  return {
    owningSourceIds: new Set(owning.map((source) => source.id)),
    readOnByAsset,
    schedulesByAsset,
  };
}

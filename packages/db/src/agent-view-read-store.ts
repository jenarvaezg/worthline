import type { ExportedPublicId, Workspace } from "@worthline/domain";

import { readAgentViewPublicIds } from "./agent-view-public-ids";
import type { StoreContext } from "./store-context";

export interface AgentViewReadStore {
  readWorkspace: () => Workspace | null;
  readPublicIds: () => ExportedPublicId[];
}

export function createAgentViewReadStore(ctx: StoreContext): AgentViewReadStore {
  return {
    readWorkspace: () => ctx.getWorkspace(),
    readPublicIds: () => readAgentViewPublicIds(ctx.db),
  };
}

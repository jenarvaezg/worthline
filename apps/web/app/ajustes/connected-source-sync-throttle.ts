import { createHash } from "node:crypto";

import type { StoreTarget } from "@web/store-resolver";

export const CONNECTED_SOURCE_SYNC_LIMIT = 6;

export type ConnectedSourceSyncPlan =
  | { mode: "count"; key: string; limit: number }
  | { mode: "bypass" };

export function connectedSourceSyncWindow(nowIso: string): string {
  return nowIso.slice(0, 13);
}

export function connectedSourceSyncPlan(input: {
  target: StoreTarget;
  userEmail: string | null;
}): ConnectedSourceSyncPlan {
  if (input.target.kind === "local") {
    return { mode: "bypass" };
  }

  const userKey =
    input.userEmail ??
    (input.target.kind === "authenticated"
      ? input.target.workspaceId
      : input.target.kind);

  return {
    mode: "count",
    key: `connected-source-sync:user:${hashKey(userKey)}`,
    limit: CONNECTED_SOURCE_SYNC_LIMIT,
  };
}

function hashKey(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

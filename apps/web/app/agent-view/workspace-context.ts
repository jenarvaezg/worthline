import type { AgentViewReadStore } from "@worthline/db";

import type { AgentViewWarningOverride, AgentViewWorkspaceInfo } from "./contract";
import { publicIdMap, requirePublicId } from "./scope-resolution";

/**
 * Surface the workspace's settings (#467, PRD #417 S3), with no side effects:
 * its mode and base currency, so the assistant matches the workspace instead of
 * assuming household/EUR. Both null until the workspace is provisioned — a
 * documented uninitialized shape, never a guess.
 */
export async function buildWorkspaceInfo(
  store: AgentViewReadStore,
): Promise<AgentViewWorkspaceInfo> {
  const workspace = await store.readWorkspace();

  return {
    object: "workspace",
    mode: workspace?.mode ?? null,
    baseCurrency: workspace?.baseCurrency ?? null,
  };
}

/**
 * List the acknowledged overrideable warnings (#467, PRD #417 S3): each warning's
 * code and the public holding ID whose warning was silenced. A pure read —
 * surfacing an override never writes one. Maps each override's internal entity id
 * to its public `wl_hld_…` via the registry.
 */
export async function buildWarningOverrides(
  store: AgentViewReadStore,
): Promise<AgentViewWarningOverride[]> {
  const overrides = await store.readWarningOverrides();
  const holdingPublicIds = publicIdMap(await store.readPublicIds(), "holding");

  return overrides.map((override) => ({
    object: "warning_override",
    code: override.code,
    holding: requirePublicId(holdingPublicIds, override.entityId),
  }));
}

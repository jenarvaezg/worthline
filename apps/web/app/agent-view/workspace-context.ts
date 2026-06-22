import type { AgentViewReadStore } from "@worthline/db";

import type {
  AgentViewMemberProfile,
  AgentViewWarningOverride,
  AgentViewWorkspaceInfo,
} from "./contract";
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

/**
 * The active members' profiles (PRD #421, #423): each member's public ID, name
 * and the optional profile fields (birth year, fiscal country, risk tolerance),
 * so the assistant can personalize advice. A pure read; disabled members are
 * omitted, matching the scope view. Each field is `null` until the user sets it.
 */
export async function buildMemberProfiles(
  store: AgentViewReadStore,
): Promise<AgentViewMemberProfile[]> {
  const workspace = await store.readWorkspace();

  if (!workspace) {
    return [];
  }

  const memberPublicIds = publicIdMap(await store.readPublicIds(), "member");

  return workspace.members
    .filter((member) => !member.disabledAt)
    .map((member) => ({
      object: "member_profile" as const,
      id: requirePublicId(memberPublicIds, member.id),
      name: member.name,
      birthYear: member.birthYear ?? null,
      fiscalCountry: member.fiscalCountry ?? null,
      riskTolerance: member.riskTolerance ?? null,
    }));
}

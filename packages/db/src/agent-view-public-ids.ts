import type {
  ExportedPublicId,
  ExportedPublicIdEntityType,
  Member,
  MemberGroup,
  Workspace,
} from "@worthline/domain";
import { asc } from "drizzle-orm";

import { agentViewPublicIds } from "./schema";
import type { StoreContext, StoreDb } from "./store-context";

export interface AgentViewPublicIdTarget {
  entityType: ExportedPublicIdEntityType;
  entityId: string;
}

const PUBLIC_ID_PREFIX: Record<ExportedPublicIdEntityType, string> = {
  holding: "wl_hld_",
  member: "wl_mbr_",
  member_group: "wl_grp_",
  scope: "wl_scp_",
};

export function createAgentViewPublicId(
  entityType: ExportedPublicIdEntityType,
  newId: () => string,
): string {
  // Lowercase is part of the public-id contract enforced by import validation
  // (^prefix[a-f0-9]{32}$); pin it here so the format holds regardless of the
  // injected newId source.
  return `${PUBLIC_ID_PREFIX[entityType]}${newId().replaceAll("-", "").toLowerCase()}`;
}

export function publicIdTargetsForWorkspace(
  workspace: Pick<Workspace, "members" | "groups">,
): AgentViewPublicIdTarget[] {
  return [
    { entityType: "scope", entityId: "household" },
    ...workspace.members.flatMap((member) => publicIdTargetsForMember(member)),
    ...workspace.groups.flatMap((group) => publicIdTargetsForMemberGroup(group)),
  ];
}

export function publicIdTargetsForMember(
  member: Pick<Member, "id">,
): AgentViewPublicIdTarget[] {
  return [
    { entityType: "member", entityId: member.id },
    { entityType: "scope", entityId: member.id },
  ];
}

export function publicIdTargetsForMemberGroup(
  group: Pick<MemberGroup, "id">,
): AgentViewPublicIdTarget[] {
  return [
    { entityType: "member_group", entityId: group.id },
    { entityType: "scope", entityId: group.id },
  ];
}

/**
 * The agent-view public-id target of one holding (#335): a single `holding`
 * entry keyed by the asset/liability id. Both kinds share the `holding` entity
 * type — the agent view exposes assets and liabilities under one opaque id space.
 */
export function publicIdTargetsForHolding(holdingId: string): AgentViewPublicIdTarget[] {
  return [{ entityType: "holding", entityId: holdingId }];
}

export async function ensureAgentViewPublicIds(
  ctx: StoreContext,
  targets: AgentViewPublicIdTarget[],
): Promise<void> {
  const rows = await ctx.db
    .select({
      entityId: agentViewPublicIds.entityId,
      entityType: agentViewPublicIds.entityType,
    })
    .from(agentViewPublicIds)
    .all();
  const existing = new Set(rows.map((row) => publicIdKey(row)));

  for (const target of targets) {
    if (existing.has(publicIdKey(target))) {
      continue;
    }

    await ctx.db
      .insert(agentViewPublicIds)
      .values({
        entityId: target.entityId,
        entityType: target.entityType,
        publicId: createAgentViewPublicId(target.entityType, ctx.newId),
      })
      .run();
    existing.add(publicIdKey(target));
  }
}

export async function readAgentViewPublicIds(db: StoreDb): Promise<ExportedPublicId[]> {
  return db
    .select({
      entityId: agentViewPublicIds.entityId,
      entityType: agentViewPublicIds.entityType,
      publicId: agentViewPublicIds.publicId,
    })
    .from(agentViewPublicIds)
    .orderBy(asc(agentViewPublicIds.entityType), asc(agentViewPublicIds.entityId))
    .all();
}

function publicIdKey(target: AgentViewPublicIdTarget): string {
  return `${target.entityType}:${target.entityId}`;
}

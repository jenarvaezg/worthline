import type { AgentViewReadStore } from "@worthline/db";
import type { ExportedPublicIdEntityType, Member } from "@worthline/domain";
import { listScopeOptions, resolveScopeMemberIds } from "@worthline/domain";

import {
  AgentViewHttpError,
  type AgentViewObjectReference,
  type AgentViewScope,
} from "./contract";

export async function listAgentViewScopes(
  store: AgentViewReadStore,
): Promise<AgentViewScope[]> {
  const workspace = await store.readWorkspace();

  if (!workspace) {
    return [];
  }

  const publicIds = new Map(
    (await store.readPublicIds()).map((entry) => [
      publicIdKey(entry.entityType, entry.entityId),
      entry.publicId,
    ]),
  );
  const activeMembers = new Map(
    workspace.members
      .filter((member) => !member.disabledAt)
      .map((member) => [member.id, member]),
  );

  return listScopeOptions(workspace).map((scope) => ({
    id: requirePublicId(publicIds, "scope", scope.id),
    isDefault: scope.id === "household",
    label: scope.label,
    members: resolveScopeMemberIds(workspace, scope.id).map((memberId) =>
      memberReference(publicIds, activeMembers, memberId),
    ),
    object: "scope",
    type: scope.type,
  }));
}

function memberReference(
  publicIds: Map<string, string>,
  activeMembers: Map<string, Member>,
  memberId: string,
): AgentViewObjectReference {
  const member = activeMembers.get(memberId);

  if (!member) {
    throw new AgentViewHttpError({
      code: "internal_error",
      message: "Agent view scope references a member that is not available.",
      status: 500,
    });
  }

  return {
    id: requirePublicId(publicIds, "member", member.id),
    label: member.name,
    object: "member",
  };
}

function requirePublicId(
  publicIds: Map<string, string>,
  entityType: ExportedPublicIdEntityType,
  entityId: string,
): string {
  const publicId = publicIds.get(publicIdKey(entityType, entityId));

  if (!publicId) {
    throw new AgentViewHttpError({
      code: "internal_error",
      message: "Agent view public ID registry is incomplete.",
      status: 500,
    });
  }

  return publicId;
}

function publicIdKey(entityType: ExportedPublicIdEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

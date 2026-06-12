import type { Member, Workspace } from "./workspace-types";

export type ScopeType = "household" | "member" | "group";

export interface ScopeOption {
  id: string;
  label: string;
  type: ScopeType;
}

export function listScopeOptions(workspace: Workspace): ScopeOption[] {
  const members = workspace.members.filter((member) => !member.disabledAt);

  return [
    { id: "household", label: "Hogar", type: "household" },
    ...members.map((member) => ({
      id: member.id,
      label: member.name,
      type: "member" as const,
    })),
    ...workspace.groups.map((group) => ({
      id: group.id,
      label: group.name,
      type: "group" as const,
    })),
  ];
}

export function resolveScopeMemberIds(workspace: Workspace, scopeId: string): string[] {
  if (scopeId === "household") {
    return activeMemberIds(workspace.members);
  }

  const member = workspace.members.find(
    (candidate) => candidate.id === scopeId && !candidate.disabledAt,
  );

  if (member) {
    return [member.id];
  }

  const group = workspace.groups.find((candidate) => candidate.id === scopeId);

  if (group) {
    const activeIds = new Set(activeMemberIds(workspace.members));
    return group.memberIds.filter((memberId) => activeIds.has(memberId));
  }

  throw new Error(`Unknown scope ${scopeId}.`);
}

function activeMemberIds(members: Member[]): string[] {
  return members.filter((member) => !member.disabledAt).map((member) => member.id);
}

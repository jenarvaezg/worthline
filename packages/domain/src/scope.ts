import type { Member, Workspace } from "./workspace-types";

export type ScopeType = "household" | "member" | "group";

export interface ScopeOption {
  id: string;
  label: string;
  type: ScopeType;
}

export function listScopeOptions(workspace: Workspace): ScopeOption[] {
  const members = workspace.members.filter((member) => !member.disabledAt);

  // In individual mode the household and its single person are the same scope,
  // so offering both ("Hogar" + the name) is redundant noise (#269). Collapse to
  // a single household scope: every consumer then treats an individual workspace
  // as one scope — the topbar's `scopes.length > 1` guard hides the selector, and
  // the per-scope snapshot/backfill loops stop double-capturing identical data.
  // The id stays "household" so the default selected scope and any existing
  // household-keyed snapshots / FIRE config carry over untouched.
  if (workspace.mode === "individual") {
    return [{ id: "household", label: "Hogar", type: "household" }];
  }

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

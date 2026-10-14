import type { TenancyDirectory } from "./control-plane";
import type { TursoPort } from "./provisioner";

/**
 * The sharing door (#1841, S1 of #1718, ADR 0112): an owner gives a read-only
 * view of THEIR workspace to another identity, and takes it back. The workspace
 * is never a parameter — it is resolved from the owner's own grant — so nobody
 * can share a workspace they do not own, and a viewer grant never passes as
 * ownership.
 *
 * The viewer opens the workspace with a Turso `read-only` token, minted the
 * first time the owner shares and sealed on the workspace row BEFORE any viewer
 * grant exists: a grant without a read-only token would be access with nothing
 * safe to open it with.
 */

/** At most this many viewers per workspace (#1718 triage). */
export const MAX_VIEWERS_PER_WORKSPACE = 5;

/**
 * Why a share was refused — every reason an expected outcome, not a failure:
 * - `invalid-email`: the viewer's address is not an email.
 * - `self-share`: the owner named themselves.
 * - `viewer-limit`: the workspace already has {@link MAX_VIEWERS_PER_WORKSPACE}.
 * - `no-owned-workspace`: the identity owns no workspace (a viewer grant is not
 *   ownership).
 * - `already-granted`: the identity holds a non-viewer grant on the workspace.
 */
export type ShareWorkspaceRefusal =
  | "invalid-email"
  | "self-share"
  | "viewer-limit"
  | "no-owned-workspace"
  | "already-granted";

export class ShareWorkspaceRefusedError extends Error {
  readonly reason: ShareWorkspaceRefusal;

  constructor(reason: ShareWorkspaceRefusal) {
    super(`Sharing the workspace read-only was refused: ${reason}.`);
    this.name = "ShareWorkspaceRefusedError";
    this.reason = reason;
  }
}

export interface ShareWorkspaceDeps {
  controlPlane: Pick<
    TenancyDirectory,
    | "findOrCreateUser"
    | "findUserByEmail"
    | "listOwnedWorkspacesForUser"
    | "listViewersOfWorkspace"
    | "readGrant"
    | "recordGrant"
    | "setWorkspaceReadOnlyToken"
  >;
  turso: Pick<TursoPort, "createDatabaseToken">;
}

export interface SharedWorkspace {
  workspaceId: string;
  viewer: { userId: string; email: string };
  /** False when the viewer already had access: sharing again changes nothing. */
  created: boolean;
}

/**
 * A pragmatic shape check, not RFC 5322: one `@`, a non-empty local part, a
 * dotted domain, no whitespace. Google verifies the address at sign-in; this
 * only keeps typos and junk out of the users table.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

/** Trimmed and lower-cased: the one comparable form of an email address. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function shareWorkspaceReadOnly(
  { controlPlane, turso }: ShareWorkspaceDeps,
  input: { ownerEmail: string; viewerEmail: string },
): Promise<SharedWorkspace> {
  const viewerEmail = normalizeEmail(input.viewerEmail);
  if (viewerEmail.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(viewerEmail)) {
    throw new ShareWorkspaceRefusedError("invalid-email");
  }
  if (viewerEmail === normalizeEmail(input.ownerEmail)) {
    throw new ShareWorkspaceRefusedError("self-share");
  }

  const owner = await controlPlane.findUserByEmail(input.ownerEmail);
  const [workspace] = owner
    ? await controlPlane.listOwnedWorkspacesForUser(owner.id)
    : [];
  if (!owner || !workspace) {
    throw new ShareWorkspaceRefusedError("no-owned-workspace");
  }

  const viewers = await controlPlane.listViewersOfWorkspace(workspace.id);
  const existing = viewers.find((viewer) => normalizeEmail(viewer.email) === viewerEmail);
  if (existing) {
    return {
      created: false,
      viewer: { email: existing.email, userId: existing.userId },
      workspaceId: workspace.id,
    };
  }
  if (viewers.length >= MAX_VIEWERS_PER_WORKSPACE) {
    throw new ShareWorkspaceRefusedError("viewer-limit");
  }

  // The read-only credential exists before the grant does: if minting fails,
  // the share fails with no grant and no user row written.
  if (!workspace.hasReadOnlyToken) {
    const { jwt } = await turso.createDatabaseToken(workspace.dbName, "read-only");
    await controlPlane.setWorkspaceReadOnlyToken(workspace.id, jwt);
  }

  // Only the user row: no database, no trial, no provisioning cap. The viewer's
  // own workspace is provisioned on their first sign-in, like anyone's.
  const viewer = await controlPlane.findOrCreateUser(viewerEmail);
  if (viewer.id === owner.id) {
    throw new ShareWorkspaceRefusedError("self-share");
  }
  const grant = await controlPlane.readGrant(viewer.id, workspace.id);
  if (grant) {
    if (grant.role !== "viewer") {
      throw new ShareWorkspaceRefusedError("already-granted");
    }
    return sharedWith(workspace.id, viewer, false);
  }
  try {
    await controlPlane.recordGrant(viewer.id, workspace.id, "viewer");
  } catch (error) {
    // A concurrent share of the same viewer won the insert: same outcome.
    const raced = await controlPlane.readGrant(viewer.id, workspace.id);
    if (raced?.role === "viewer") return sharedWith(workspace.id, viewer, false);
    throw error;
  }
  return sharedWith(workspace.id, viewer, true);
}

function sharedWith(
  workspaceId: string,
  viewer: { id: string; email: string },
  created: boolean,
): SharedWorkspace {
  return { created, viewer: { email: viewer.email, userId: viewer.id }, workspaceId };
}

export interface RevokeWorkspaceDeps {
  controlPlane: Pick<
    TenancyDirectory,
    "findUserByEmail" | "listOwnedWorkspacesForUser" | "revokeViewerGrant"
  >;
}

/**
 * Take a viewer's access back from the owner's OWN workspace. True when a
 * viewer grant was removed; false when the identity owns nothing or the user
 * was not a viewer of it. Never touches an owner grant.
 */
export async function revokeWorkspaceReadOnly(
  { controlPlane }: RevokeWorkspaceDeps,
  input: { ownerEmail: string; viewerUserId: string },
): Promise<boolean> {
  const owner = await controlPlane.findUserByEmail(input.ownerEmail);
  if (!owner) return false;
  const [workspace] = await controlPlane.listOwnedWorkspacesForUser(owner.id);
  if (!workspace) return false;
  return controlPlane.revokeViewerGrant(workspace.id, input.viewerUserId);
}

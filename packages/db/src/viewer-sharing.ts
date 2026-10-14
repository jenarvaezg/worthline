import { comparableEmail } from "./comparable-email";
import type {
  ControlPlaneUser,
  ControlPlaneWorkspace,
  TenancyDirectory,
} from "./control-plane";
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
 * - `conflicting-grant`: the identity already holds a grant of another kind on
 *   the workspace (a legacy `orphaned-owner`, an unknown role). It is NOT «already
 *   a viewer» — that is a success with `created: false` — and it cannot be turned
 *   into one from the sharing door.
 */
export type ShareWorkspaceRefusal =
  | "invalid-email"
  | "self-share"
  | "viewer-limit"
  | "no-owned-workspace"
  | "conflicting-grant";

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
    | "recordViewerGrant"
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
 * only keeps typos and junk out of the users table. Exported so the web's copy
 * (which the client island needs without this package's runtime) is pinned to
 * these values by a test.
 */
export const VIEWER_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_VIEWER_EMAIL_LENGTH = 254;

/** The identity behind an email and the workspace it owns, if any. */
export interface OwnedWorkspaceLookup {
  user: ControlPlaneUser;
  /** Null when the identity owns nothing — a viewer grant is not ownership. */
  workspace: ControlPlaneWorkspace | null;
}

/**
 * The identity an email names and the ONE workspace it owns (#733: at most
 * one), or null when the control plane does not know the email. The way every
 * sharing entry point resolves «the owner's workspace» from the session's email,
 * so none takes a workspace id a form could forge.
 */
export async function findOwnedWorkspace(
  controlPlane: Pick<TenancyDirectory, "findUserByEmail" | "listOwnedWorkspacesForUser">,
  email: string,
): Promise<OwnedWorkspaceLookup | null> {
  const user = await controlPlane.findUserByEmail(email);
  if (!user) return null;
  const [workspace] = await controlPlane.listOwnedWorkspacesForUser(user.id);
  return { user, workspace: workspace ?? null };
}

export async function shareWorkspaceReadOnly(
  { controlPlane, turso }: ShareWorkspaceDeps,
  input: { ownerEmail: string; viewerEmail: string },
): Promise<SharedWorkspace> {
  const viewerEmail = comparableEmail(input.viewerEmail);
  if (
    viewerEmail.length > MAX_VIEWER_EMAIL_LENGTH ||
    !VIEWER_EMAIL_SHAPE.test(viewerEmail)
  ) {
    throw new ShareWorkspaceRefusedError("invalid-email");
  }
  if (viewerEmail === comparableEmail(input.ownerEmail)) {
    throw new ShareWorkspaceRefusedError("self-share");
  }

  const owned = await findOwnedWorkspace(controlPlane, input.ownerEmail);
  if (!owned?.workspace) {
    throw new ShareWorkspaceRefusedError("no-owned-workspace");
  }
  const { user: owner, workspace } = owned;

  const viewers = await controlPlane.listViewersOfWorkspace(workspace.id);
  const existing = viewers.find(
    (viewer) => comparableEmail(viewer.email) === viewerEmail,
  );
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
  // the share fails with no grant and no user row written. The seal is set
  // once, so two concurrent first shares converge on whichever landed first.
  if (!workspace.hasReadOnlyToken) {
    const { jwt } = await turso.createDatabaseToken(workspace.dbName, "read-only");
    await controlPlane.setWorkspaceReadOnlyToken(workspace.id, jwt);
  }

  // Only the user row: no database, no trial, no provisioning cap. The viewer's
  // own workspace is provisioned on their first sign-in, like anyone's.
  // An existing identity is reused whatever the case of its stored email.
  const viewer = await controlPlane.findOrCreateUser(viewerEmail);
  if (viewer.id === owner.id) {
    throw new ShareWorkspaceRefusedError("self-share");
  }
  // The atomic arbiter of the cap: the check above only spares a token mint
  // and a user row when the workspace is visibly full.
  const outcome = await controlPlane.recordViewerGrant(
    viewer.id,
    workspace.id,
    MAX_VIEWERS_PER_WORKSPACE,
  );
  switch (outcome) {
    case "recorded":
      return sharedWith(workspace.id, viewer, true);
    case "already-viewer":
      return sharedWith(workspace.id, viewer, false);
    case "conflicting-grant":
      throw new ShareWorkspaceRefusedError("conflicting-grant");
    case "viewer-limit":
      throw new ShareWorkspaceRefusedError("viewer-limit");
  }
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
  const workspace = (await findOwnedWorkspace(controlPlane, input.ownerEmail))?.workspace;
  if (!workspace) return false;
  return controlPlane.revokeViewerGrant(workspace.id, input.viewerUserId);
}

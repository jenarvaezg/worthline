/**
 * The control-plane seam of «Acceso de solo lectura» (#1844, ADR 0112): what the
 * owner's sharing actions and the /ajustes and /bienvenida reads open, in one
 * place. Server-only — it opens the control plane and, on a first share, reaches
 * Turso's Platform API to mint the workspace's read-only token.
 *
 * Every entry point takes the identity as an EMAIL (the session's), never a
 * workspace id: the S1 commands resolve the workspace from the owner's grant, and
 * the reads here do the same, so nothing a form posts can point at someone
 * else's workspace.
 */

import { withControlPlaneStore } from "@web/control-plane-store";
import { tursoPortFromEnv } from "@web/turso-port";
import {
  type ControlPlaneStore,
  findOwnedWorkspace,
  type RevokeWorkspaceDeps,
  type ShareWorkspaceDeps,
  type WorkspaceSharedWithUser,
  type WorkspaceViewer,
} from "@worthline/db";

/** The ports the sharing commands need (`shareWorkspaceReadOnly`, `revokeWorkspaceReadOnly`). */
export interface SharingPorts {
  controlPlane: ShareWorkspaceDeps["controlPlane"] & RevokeWorkspaceDeps["controlPlane"];
  turso: ShareWorkspaceDeps["turso"];
}

/**
 * Test-injection seam for the sharing actions, wrapped in an object so the
 * action-args predicate cannot mistake another injected value for it (the shape
 * of `isFxRatesOverride`).
 */
export function isSharingPortsOverride(
  value: unknown,
): value is { sharingPorts: SharingPorts } {
  return typeof value === "object" && value !== null && "sharingPorts" in value;
}

/**
 * Hand the sharing ports to `run`: the injected ones (tests), or the real control
 * plane — opened and always closed — with a Turso port built only when a first
 * share actually mints a token, so taking access back never needs Turso's env.
 */
export async function withSharingPorts<T>(
  run: (ports: SharingPorts) => Promise<T>,
  injected?: SharingPorts,
): Promise<T> {
  if (injected) return run(injected);
  return withControlPlaneStore<T, ControlPlaneStore>(
    (controlPlane) =>
      run({
        controlPlane,
        turso: {
          createDatabaseToken: (name, authorization) =>
            tursoPortFromEnv(process.env).createDatabaseToken(name, authorization),
        },
      }),
    { purpose: "Sharing a workspace read-only" },
  );
}

/** Who may view the identity's own workspace, and whose workspaces it may view. */
export interface WorkspaceSharing {
  viewers: WorkspaceViewer[];
  sharedWithMe: WorkspaceSharedWithUser[];
}

type SharingReadPort = Pick<
  ControlPlaneStore,
  | "findUserByEmail"
  | "listOwnedWorkspacesForUser"
  | "listViewersOfWorkspace"
  | "listWorkspacesSharedWithUser"
>;

/**
 * Read both lists for `email`, in one control-plane connection. An identity the
 * control plane does not know has neither: an empty pair, not an error.
 */
export async function loadWorkspaceSharing(
  email: string,
  injected?: SharingReadPort,
): Promise<WorkspaceSharing> {
  return withControlPlaneStore<WorkspaceSharing, SharingReadPort>(
    async (controlPlane) => {
      const owned = await findOwnedWorkspace(controlPlane, email);
      if (!owned) return { sharedWithMe: [], viewers: [] };
      // An identity that owns nothing yet — someone only invited, before their
      // own workspace exists — still has what was shared with it.
      const [viewers, sharedWithMe] = await Promise.all([
        owned.workspace ? controlPlane.listViewersOfWorkspace(owned.workspace.id) : [],
        controlPlane.listWorkspacesSharedWithUser(owned.user.id),
      ]);
      return { sharedWithMe, viewers };
    },
    {
      purpose: "Reading who a workspace is shared with",
      ...(injected ? { injectedStore: injected } : {}),
    },
  );
}

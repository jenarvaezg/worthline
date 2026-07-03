import type { ControlPlaneStore, ControlPlaneWorkspaceWithOwner } from "@worthline/db";

import { withControlPlaneStore } from "@web/admin/admin-control-plane";

/** The admin user list (#697): every workspace with its owner's email, oldest first. */
export async function listAdminWorkspaces(
  injectedStore?: ControlPlaneStore,
): Promise<ControlPlaneWorkspaceWithOwner[]> {
  return withControlPlaneStore(
    (store) => store.listWorkspacesWithOwners(),
    injectedStore,
  );
}

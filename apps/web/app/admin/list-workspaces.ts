import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import type { ControlPlaneWorkspaceWithOwner, TenancyDirectory } from "@worthline/db";

/** The admin user list (#697): every workspace with its owner's email, oldest first. */
export async function listAdminWorkspaces(
  injectedStore?: Pick<TenancyDirectory, "listWorkspacesWithOwners">,
): Promise<ControlPlaneWorkspaceWithOwner[]> {
  return withControlPlaneStore(
    (store: Pick<TenancyDirectory, "listWorkspacesWithOwners">) =>
      store.listWorkspacesWithOwners(),
    injectedStore,
  );
}

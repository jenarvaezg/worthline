import { actsOnOwnAccount } from "@web/demo/write-guard";
import { readSessionEmail, readStoreTarget } from "@web/read-store-target";
import { loadWorkspaceSharing } from "@web/sharing/sharing-control-plane";
import type { WorkspaceSharedWithUser } from "@worthline/db";

import SharedWithYou from "./shared-with-you";

/**
 * The workspaces shared with this session's identity (#1844), for the surfaces
 * where someone who was only invited lands: /bienvenida, and /empezar, where
 * `/app` sends a new identity whose own workspace is still empty. Only for a
 * session in its own workspace: the demo, an admin impersonating and local no-auth
 * mode have no identity of their own to list for, and nothing is read for them.
 */
export async function readWorkspacesSharedWithSession(): Promise<
  readonly WorkspaceSharedWithUser[]
> {
  if (!actsOnOwnAccount(await readStoreTarget())) return [];
  const email = await readSessionEmail();
  if (!email) return [];

  const { sharedWithMe } = await loadWorkspaceSharing(email);
  return sharedWithMe;
}

/** «Compartidos contigo» for this session's identity, read on its own. */
export default async function SharedWithSession() {
  const workspaces = await readWorkspacesSharedWithSession();
  return workspaces.length === 0 ? null : <SharedWithYou workspaces={workspaces} />;
}

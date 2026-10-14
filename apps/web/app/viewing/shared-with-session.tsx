import { actsOnOwnAccount } from "@web/demo/write-guard";
import { readSessionEmail, readStoreTarget } from "@web/read-store-target";
import { loadWorkspaceSharing } from "@web/sharing/sharing-control-plane";

import SharedWithYou from "./shared-with-you";

/**
 * «Compartidos contigo» for this session's identity (#1844), read on its own for
 * the surfaces that show only this list — /bienvenida, where someone who was only
 * invited lands after their first sign-in. Only for a session in its own
 * workspace: the demo, an admin impersonating and local no-auth mode have no
 * identity of their own to list for, and nothing is read for them.
 */
export default async function SharedWithSession() {
  if (!actsOnOwnAccount(await readStoreTarget())) return null;
  const email = await readSessionEmail();
  if (!email) return null;

  const { sharedWithMe } = await loadWorkspaceSharing(email);
  return <SharedWithYou workspaces={sharedWithMe} />;
}

import { readStoreTarget } from "@web/read-store-target";

import FeedbackLauncher from "./feedback-launcher";

/**
 * Server gate for «Enviar feedback» (#1174), mounted in the workspace topbar.
 *
 * Only a signed-in user's OWN session sees it — the same reach the action
 * accepts, so the button never offers a send the server would refuse:
 *   - the read-only demo is public and anonymous: no one to answer, and an open
 *     door to the maintainer's inbox;
 *   - the local no-auth mode has no control plane to keep the message in;
 *   - an admin impersonating a workspace must not write in that user's name.
 */
export default async function FeedbackMount() {
  const target = await readStoreTarget();
  if (target.kind !== "authenticated" || target.impersonatedEmail !== undefined) {
    return null;
  }
  return <FeedbackLauncher />;
}

import { readStoreTarget } from "@web/read-store-target";

import { canSendFeedback } from "./feedback-eligibility";
import FeedbackLauncher from "./feedback-launcher";

/**
 * Server gate for «Enviar feedback» (#1174) on the surfaces that render on the
 * server: the workspace topbar and the /empezar masthead. It shows the button
 * only to a session the action would accept (`canSendFeedback`), so the button
 * never offers a send the server would refuse.
 */
export default async function FeedbackMount() {
  return canSendFeedback(await readStoreTarget()) ? <FeedbackLauncher /> : null;
}

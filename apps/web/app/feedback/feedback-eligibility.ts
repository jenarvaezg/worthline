import type { StoreTarget } from "@web/store-resolver";

/**
 * Who may send feedback (#1174) — the ONE rule the server action enforces and
 * every mount uses to decide whether to show the button, so the button never
 * offers a send the server would refuse:
 *   - a signed-in user's OWN session: there is someone to answer;
 *   - not the read-only demo: public and anonymous, an open door to the inbox;
 *   - not the local no-auth mode: no control plane to keep the message in;
 *   - not an admin impersonating a workspace: never in that user's name.
 */
export function canSendFeedback(
  target: StoreTarget,
): target is Extract<StoreTarget, { kind: "authenticated" }> {
  return target.kind === "authenticated" && target.impersonatedEmail === undefined;
}

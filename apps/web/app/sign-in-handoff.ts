import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Hand the workspace the `signIn` callback resolved to the `jwt` callback of the
 * SAME sign-in request (#1175, ADR 0110).
 *
 * Provisioning moved to `signIn` because only `signIn` can refuse with a
 * redirect; `jwt` still has to pin the workspace into the token. Without this
 * handoff `jwt` re-resolved it, opening the control plane — and re-running its
 * schema bootstrap — a second time on every login. Auth.js offers no supported
 * channel between its callbacks, so the auth route opens one request-scoped
 * store and the two callbacks meet there. Nothing is cached across requests:
 * the store lives exactly as long as one callback request, and an entry is
 * taken (read and removed) by the callback it was left for.
 *
 * When there is no scope (any path that does not go through the auth route)
 * the handoff is simply empty, and `jwt` falls back to resolving the workspace
 * itself — slower, never wrong, and an existing user is never refused there.
 */

/** What `jwt` pins into the token. Kept structural so this module imports nothing. */
export interface HandedOffWorkspace {
  id: string;
  dbUrl: string;
  dbAuthToken: string | null;
}

const handoff = new AsyncLocalStorage<Map<string, HandedOffWorkspace>>();

/** Run one auth request with its own, empty handoff. */
export function withSignInHandoff<T>(run: () => Promise<T>): Promise<T> {
  return handoff.run(new Map(), run);
}

/** Leave the resolved workspace for this request's `jwt` callback. */
export function handOffSignInWorkspace(
  email: string,
  workspace: HandedOffWorkspace,
): void {
  handoff.getStore()?.set(email, workspace);
}

/** Take (read and remove) what `signIn` left for this identity, if anything. */
export function takeSignInWorkspace(email: string): HandedOffWorkspace | undefined {
  const store = handoff.getStore();
  const workspace = store?.get(email);
  store?.delete(email);
  return workspace;
}

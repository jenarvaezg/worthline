import { SCOPE_COOKIE_NAME } from "@web/intake";
import { VIEWING_COOKIE_NAME } from "@web/viewing/viewing-cookie";
import { cookies } from "next/headers";

import { readStoreTarget } from "./read-store-target";

/**
 * Top-right «Cerrar sesión» control (ADR 0030). Server component: it resolves
 * the request store target and renders NOTHING unless the request is an
 * authenticated session — so the read-only demo and the local no-auth mode
 * never show it. Zero client JS (ADR 0009): a server-action POST that ends the
 * session and returns home (`/`, which the proxy sends to the sign-in
 * landing once signed out).
 *
 * `next-auth` is imported lazily inside the action — which only runs for an
 * authenticated submit — so demo/local renders (and their tests) never pull the
 * auth stack into the bundle, mirroring `readStoreTarget`.
 */
export default async function SignOutButton() {
  const target = await readStoreTarget();
  if (target.kind !== "authenticated") {
    return null;
  }

  return (
    <form
      className="signOutForm"
      action={async () => {
        "use server";
        // The viewer session and the member scope end with the account (#1843):
        // the next account on this browser starts in its own workspace.
        const jar = await cookies();
        jar.delete(VIEWING_COOKIE_NAME);
        jar.delete(SCOPE_COOKIE_NAME);
        const { signOut } = await import("@web/auth");
        await signOut({ redirectTo: "/" });
      }}
    >
      <button className="signOutBtn" type="submit">
        Cerrar sesión
      </button>
    </form>
  );
}

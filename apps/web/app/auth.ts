import config from "@web/auth.config";
import { admitSignIn, provisionWorkspaceForEmail } from "@web/provisioning";
import NextAuth, { AuthError } from "next-auth";

/**
 * Full (Node-runtime) Auth.js config (ADR 0030). The edge-safe half lives in
 * `auth.config.ts` (consumed by the proxy); the provisioning callbacks
 * below run only here — in the sign-in route and `auth()` — because they touch
 * the control-plane database and the Turso Platform API, neither edge-safe.
 *
 * Provision-on-first-login happens in the `signIn` callback (#1175): it resolves
 * the user's workspace — creating and migrating a fresh one the first time —
 * and is the one callback that can REFUSE with a redirect, which is how a new
 * identity past the day's provisioning cap reaches the honest «hoy estamos
 * llenos» instead of a server error. An existing user is never refused.
 *
 * The `jwt` callback then pins the workspace id + URL + per-database Turso
 * token (#1185) into the JWT; by then the workspace exists, so its lookup
 * creates nothing. The `session` callback exposes that to server code, so the
 * store resolver reads the workspace straight off the session with no
 * per-request control-plane query.
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  ...config,
  callbacks: {
    async signIn({ user, account }) {
      if (!account || !user.email) return true;
      try {
        return await admitSignIn(user.email);
      } catch (error) {
        // A real provisioning failure (a Turso outage, …). Auth.js reads a plain
        // throw from `signIn` as AccessDenied — «no tienes permiso» — which would
        // lie; an AuthError lands on the server-error page, exactly what a
        // provisioning failure showed when it ran in `jwt`.
        throw new AuthError("Workspace provisioning failed during sign-in.", {
          cause: error,
        });
      }
    },
    async jwt({ token, account }) {
      if (account && token.email) {
        const workspace = await provisionWorkspaceForEmail(token.email);
        token.workspaceId = workspace.id;
        token.dbUrl = workspace.dbUrl;
        if (workspace.dbAuthToken) {
          token.dbAuthToken = workspace.dbAuthToken;
        }
      }
      return token;
    },
    session({ session, token }) {
      if (token.workspaceId && token.dbUrl) {
        session.workspace = {
          id: token.workspaceId,
          dbUrl: token.dbUrl,
          ...(token.dbAuthToken ? { dbAuthToken: token.dbAuthToken } : {}),
        };
      }
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    /** The signed-in user's workspace, resolved at sign-in (ADR 0030). */
    workspace?: { id: string; dbUrl: string; dbAuthToken?: string };
  }
}

// JWT is defined in `@auth/core/jwt`; `next-auth/jwt` only re-exports it, so the
// augmentation must target the defining module to merge into the interface.
declare module "@auth/core/jwt" {
  interface JWT {
    workspaceId?: string;
    dbUrl?: string;
    dbAuthToken?: string;
  }
}

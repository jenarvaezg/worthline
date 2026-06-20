import NextAuth from "next-auth";

import config from "@web/auth.config";
import { provisionWorkspaceForEmail } from "@web/provisioning";

/**
 * Full (Node-runtime) Auth.js config (ADR 0030). The edge-safe half lives in
 * `auth.config.ts` (consumed by the middleware); the provisioning callbacks
 * below run only here — in the sign-in route and `auth()` — because they touch
 * the control-plane database and the Turso Platform API, neither edge-safe.
 *
 * Provision-on-first-login happens in the `jwt` callback: on the sign-in event
 * (`account` present) we resolve the user's workspace — creating and migrating a
 * fresh one the first time — and pin its id + URL into the JWT. The `session`
 * callback exposes that to server code, so the store resolver reads the workspace
 * straight off the session with no per-request control-plane query.
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  ...config,
  callbacks: {
    async jwt({ token, account }) {
      if (account && token.email) {
        const workspace = await provisionWorkspaceForEmail(token.email);
        token.workspaceId = workspace.id;
        token.dbUrl = workspace.dbUrl;
      }
      return token;
    },
    session({ session, token }) {
      if (token.workspaceId && token.dbUrl) {
        session.workspace = { id: token.workspaceId, dbUrl: token.dbUrl };
      }
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    /** The signed-in user's workspace, resolved at sign-in (ADR 0030). */
    workspace?: { id: string; dbUrl: string };
  }
}

// JWT is defined in `@auth/core/jwt`; `next-auth/jwt` only re-exports it, so the
// augmentation must target the defining module to merge into the interface.
declare module "@auth/core/jwt" {
  interface JWT {
    workspaceId?: string;
    dbUrl?: string;
  }
}

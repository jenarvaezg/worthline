import { type PersonaId, parsePersonaId } from "@web/demo/persona";

export type StoreTarget =
  | {
      kind: "authenticated";
      workspaceId: string;
      dbUrl: string;
      token: string;
      /**
       * Set only when this is the admin viewing another user's workspace
       * (#697, ADR 0030) — carries that user's email for the persistent
       * banner. Absent (not `false`) on every ordinary authenticated
       * resolution, so existing callers/tests that don't know about
       * impersonation are unaffected.
       */
      impersonatedEmail?: string;
    }
  | { kind: "demo"; persona: PersonaId; now: string }
  | { kind: "local" }
  | { kind: "unauthenticated" };

export interface ResolveStoreTargetInput {
  env: Record<string, string | undefined>;
  session: {
    user?: { email?: string | null };
    /**
     * The user's own workspace, resolved at sign-in (control plane +
     * provision-on-first-login) and carried in the JWT (ADR 0030). Absent until
     * a workspace has been provisioned. `dbAuthToken` is the per-database Turso
     * JWT (#1185); legacy JWTs may omit it until the next sign-in / backfill.
     */
    workspace?: { id: string; dbUrl: string; dbAuthToken?: string };
  } | null;
  /**
   * Raw value of the `wl_demo_persona` cookie (ADR 0030). A logged-out request
   * carrying it resolves to the read-only demo persona — the deploy-wide `DEMO`
   * flag retires; the demo is per-request.
   */
  personaCookie?: string | null | undefined;
  /**
   * Workspace claims carried by a verified MCP OAuth token (ADR 0034). An MCP
   * request authenticates with a bearer token, not an Auth.js session, so the
   * workspace it may open arrives here — resolved by `verifyMcpToken` from the
   * control plane — rather than on `session.workspace`.
   */
  mcpWorkspace?:
    | { workspaceId: string; dbUrl: string; dbAuthToken?: string | null }
    | null
    | undefined;
  /**
   * The impersonation target resolved from the `wl_impersonate` cookie's
   * workspace id (a control-plane lookup — see `lookupImpersonationTarget` in
   * `read-store-target.ts`), or null/undefined when there is none to honor.
   * CRITICAL: this value alone grants nothing. It may be resolved for ANY
   * request that merely carries the cookie — including a hand-crafted one from
   * a non-admin or logged-out visitor. The `isAdmin` check computed below, from
   * THIS request's own `session`/`env`, is what decides whether it is ever
   * used. Never skip that check, and never trust a pre-computed "is admin"
   * boolean passed in from the caller instead of recomputing it here (#697).
   */
  impersonateWorkspace?:
    | {
        workspaceId: string;
        dbUrl: string;
        email: string;
        dbAuthToken?: string | null;
      }
    | null
    | undefined;
}

/**
 * Normalize an email for the admin comparison (#697): trim + lowercase.
 * Shared by every admin-email comparison (this file, `guard-admin.ts`, and the
 * session-email read in `read-store-target.ts`) so a stray capital or trailing
 * space in the deployed `WORTHLINE_ADMIN_EMAIL` — or an unusually-cased
 * session email — never compares a normalized value against a raw one and
 * silently 404s the real admin.
 */
export function normalizeAdminEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Prefer the per-workspace Turso JWT (#1185); fall back to the shared group
 * token only for pre-backfill workspaces / legacy JWTs that still lack one.
 * The group token remains required for the control plane itself.
 */
function workspaceDbToken(scoped: string | null | undefined, groupToken: string): string {
  return scoped && scoped.length > 0 ? scoped : groupToken;
}

export function resolveStoreTarget(input: ResolveStoreTargetInput): StoreTarget {
  const { env, session, personaCookie, mcpWorkspace, impersonateWorkspace } = input;
  const authConfigured = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);

  // Control-plane / legacy fallback token. Workspace data-plane opens prefer
  // the per-database JWT carried on the resolved workspace (#1185).
  const groupToken = env.WORTHLINE_DB_AUTH_TOKEN ?? "";

  // Admin impersonation (#697, ADR 0030): recomputed from THIS call's session
  // + env every time — never cached, never passed in — so it is impossible for
  // a stale or forged signal to leak through. A non-admin (or logged-out)
  // session with the impersonate cookie set falls straight through to the
  // branches below, resolving EXACTLY as if the cookie were absent.
  const adminEmail = normalizeAdminEmail(env.WORTHLINE_ADMIN_EMAIL);
  const isAdmin =
    Boolean(adminEmail) && normalizeAdminEmail(session?.user?.email) === adminEmail;

  if (isAdmin && impersonateWorkspace) {
    return {
      kind: "authenticated",
      workspaceId: impersonateWorkspace.workspaceId,
      dbUrl: impersonateWorkspace.dbUrl,
      token: workspaceDbToken(impersonateWorkspace.dbAuthToken, groupToken),
      impersonatedEmail: impersonateWorkspace.email,
    };
  }

  // An authenticated workspace always wins — a stale persona cookie left over
  // from a demo session never shadows a signed-in user's real data.
  const workspace = session?.workspace;
  if (workspace) {
    return {
      kind: "authenticated",
      workspaceId: workspace.id,
      dbUrl: workspace.dbUrl,
      token: workspaceDbToken(workspace.dbAuthToken, groupToken),
    };
  }

  // A verified MCP token resolves to exactly one workspace (ADR 0034); like a
  // session it outranks any persona cookie on the request.
  if (mcpWorkspace) {
    return {
      kind: "authenticated",
      workspaceId: mcpWorkspace.workspaceId,
      dbUrl: mcpWorkspace.dbUrl,
      token: workspaceDbToken(mcpWorkspace.dbAuthToken, groupToken),
    };
  }

  // Logged out + persona cookie ⇒ the read-only demo on an ephemeral in-memory
  // database (seeded per request). Every demo fact is seeded relative to `now`,
  // so an empty `now` lets the demo clock fall back to the real date — the demo
  // stays current instead of frozen, with no env clock to pin (nor for a
  // scheduled job to misread). See ADR 0030.
  if (personaCookie) {
    return {
      kind: "demo",
      persona: parsePersonaId(personaCookie),
      now: "",
    };
  }

  // Local no-auth mode: the control plane and sign-in never engage.
  if (!authConfigured) {
    return { kind: "local" };
  }

  return { kind: "unauthenticated" };
}

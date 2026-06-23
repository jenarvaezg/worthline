import { parsePersonaId, type PersonaId } from "@web/demo/persona";

export type StoreTarget =
  | { kind: "authenticated"; workspaceId: string; dbUrl: string; token: string }
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
     * a workspace has been provisioned.
     */
    workspace?: { id: string; dbUrl: string };
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
  mcpWorkspace?: { workspaceId: string; dbUrl: string } | null | undefined;
}

export function resolveStoreTarget(input: ResolveStoreTargetInput): StoreTarget {
  const { env, session, personaCookie, mcpWorkspace } = input;
  const authConfigured = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);

  // One shared Turso group token in env opens whichever per-workspace URL the
  // request resolves to (from the session at web sign-in, or from a verified
  // MCP token, ADR 0034). The OAuth token that identified the MCP caller is NOT
  // this token — it never reaches the store seam.
  const groupToken = env.WORTHLINE_DB_AUTH_TOKEN ?? "";

  // An authenticated workspace always wins — a stale persona cookie left over
  // from a demo session never shadows a signed-in user's real data.
  const workspace = session?.workspace;
  if (workspace) {
    return {
      kind: "authenticated",
      workspaceId: workspace.id,
      dbUrl: workspace.dbUrl,
      token: groupToken,
    };
  }

  // A verified MCP token resolves to exactly one workspace (ADR 0034); like a
  // session it outranks any persona cookie on the request.
  if (mcpWorkspace) {
    return {
      kind: "authenticated",
      workspaceId: mcpWorkspace.workspaceId,
      dbUrl: mcpWorkspace.dbUrl,
      token: groupToken,
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

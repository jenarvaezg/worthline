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
}

export function resolveStoreTarget(input: ResolveStoreTargetInput): StoreTarget {
  const { env, session, personaCookie } = input;
  const authConfigured = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);

  // An authenticated workspace always wins — a stale persona cookie left over
  // from a demo session never shadows a signed-in user's real data.
  const workspace = session?.workspace;
  if (workspace) {
    // One shared Turso group token in env; the per-workspace URL comes from the
    // control plane via the session.
    return {
      kind: "authenticated",
      workspaceId: workspace.id,
      dbUrl: workspace.dbUrl,
      token: env.WORTHLINE_DB_AUTH_TOKEN ?? "",
    };
  }

  // Logged out + persona cookie ⇒ the read-only demo on an ephemeral in-memory
  // database (seeded per request). The clock is pinned by `WORTHLINE_DEMO_NOW`.
  if (personaCookie) {
    return {
      kind: "demo",
      persona: parsePersonaId(personaCookie),
      now: (env.WORTHLINE_DEMO_NOW ?? "").trim(),
    };
  }

  // Local no-auth mode: the control plane and sign-in never engage.
  if (!authConfigured) {
    return { kind: "local" };
  }

  return { kind: "unauthenticated" };
}

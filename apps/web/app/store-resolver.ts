export type StoreTarget =
  | { kind: "authenticated"; workspaceId: string; dbUrl: string; token: string }
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
}

export function resolveStoreTarget(input: ResolveStoreTargetInput): StoreTarget {
  const { env, session } = input;
  const authConfigured = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);

  if (!authConfigured) {
    return { kind: "local" };
  }

  const workspace = session?.workspace;
  if (!workspace) {
    return { kind: "unauthenticated" };
  }

  // One shared Turso group token in env; the per-workspace URL comes from the
  // control plane via the session.
  return {
    kind: "authenticated",
    workspaceId: workspace.id,
    dbUrl: workspace.dbUrl,
    token: env.WORTHLINE_DB_AUTH_TOKEN ?? "",
  };
}

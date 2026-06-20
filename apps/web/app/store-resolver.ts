export type StoreTarget =
  | { kind: "authenticated"; workspaceId: string; dbUrl: string; token: string }
  | { kind: "local" }
  | { kind: "unauthenticated" };

export interface ResolveStoreTargetInput {
  env: Record<string, string | undefined>;
  session: { user?: { email?: string | null } } | null;
}

export function resolveStoreTarget(input: ResolveStoreTargetInput): StoreTarget {
  const { env, session } = input;
  const authConfigured = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);

  if (!authConfigured) {
    return { kind: "local" };
  }

  if (!session) {
    return { kind: "unauthenticated" };
  }

  return {
    kind: "authenticated",
    workspaceId: "default",
    dbUrl: env.WORTHLINE_DB_URL ?? "",
    token: env.WORTHLINE_DB_AUTH_TOKEN ?? "",
  };
}

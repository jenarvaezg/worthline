/**
 * The admin surface's control-plane seam (#697), mirroring `action-store.ts`'s
 * `runActionWithStore`: opens a `ControlPlaneStore` from env, hands it to
 * `run`, and always closes it — unless a store is injected (tests), whose
 * lifecycle the caller owns instead.
 */
import { type AdminControlPlaneStore, createAdminControlPlaneStore } from "@worthline/db";

function requireControlPlaneUrl(env: Record<string, string | undefined>): string {
  const url = env.WORTHLINE_CONTROL_PLANE_DB_URL;
  if (!url) {
    throw new Error("WORTHLINE_CONTROL_PLANE_DB_URL is not configured.");
  }
  return url;
}

async function openControlPlaneStore(): Promise<AdminControlPlaneStore> {
  const env = process.env;
  const url = requireControlPlaneUrl(env);
  return createAdminControlPlaneStore({
    url,
    ...(env.WORTHLINE_DB_AUTH_TOKEN ? { authToken: env.WORTHLINE_DB_AUTH_TOKEN } : {}),
  });
}

/**
 * Hand an admin control-plane port to `run`, opening (and always closing) the
 * real store unless one is injected. This is the `/admin` seam, so it opens the
 * wide {@link AdminControlPlaneStore} — the ONLY surface from which exposure-
 * catalog curation writes are reachable (#1123). Generic over the port `S` the
 * caller needs — `run`'s param and `injectedStore` narrow to just that concern,
 * so a caller touches only the methods it uses and a test can inject a fake of
 * that single port. `S` is constrained to a subset of `AdminControlPlaneStore`,
 * so the opened store (which implements every port) always satisfies it — the
 * widening cast is sound, and a foreign `S` is rejected at the call site.
 */
export async function withControlPlaneStore<
  T,
  S extends Partial<AdminControlPlaneStore> = AdminControlPlaneStore,
>(run: (store: S) => T | Promise<T>, injectedStore?: S): Promise<T> {
  if (injectedStore) {
    return run(injectedStore);
  }
  const store = await openControlPlaneStore();
  try {
    return await run(store as unknown as S);
  } finally {
    store.close();
  }
}

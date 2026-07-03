/**
 * The admin surface's control-plane seam (#697), mirroring `action-store.ts`'s
 * `runActionWithStore`: opens a `ControlPlaneStore` from env, hands it to
 * `run`, and always closes it — unless a store is injected (tests), whose
 * lifecycle the caller owns instead.
 */
import { createControlPlaneStore, type ControlPlaneStore } from "@worthline/db";

function requireControlPlaneUrl(env: Record<string, string | undefined>): string {
  const url = env.WORTHLINE_CONTROL_PLANE_DB_URL;
  if (!url) {
    throw new Error("WORTHLINE_CONTROL_PLANE_DB_URL is not configured.");
  }
  return url;
}

async function openControlPlaneStore(): Promise<ControlPlaneStore> {
  const env = process.env;
  const url = requireControlPlaneUrl(env);
  return createControlPlaneStore({
    url,
    ...(env.WORTHLINE_DB_AUTH_TOKEN ? { authToken: env.WORTHLINE_DB_AUTH_TOKEN } : {}),
  });
}

export async function withControlPlaneStore<T>(
  run: (store: ControlPlaneStore) => T | Promise<T>,
  injectedStore?: ControlPlaneStore,
): Promise<T> {
  if (injectedStore) {
    return run(injectedStore);
  }
  const store = await openControlPlaneStore();
  try {
    return await run(store);
  } finally {
    store.close();
  }
}

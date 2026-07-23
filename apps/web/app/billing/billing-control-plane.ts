/**
 * El seam de control plane del billing (PRD #1160 S5, #1165), calcado de
 * `admin-control-plane.ts` pero con el {@link ControlPlaneStore} ordinario: el
 * webhook y las superficies de upgrade no necesitan (ni deben ver) los writes
 * de curación del catálogo. Abre desde env, cierra siempre — salvo store
 * inyectado (tests), cuyo ciclo de vida es del llamante.
 */

import { type ControlPlaneStore, createControlPlaneStore } from "@worthline/db";

async function openControlPlaneStore(): Promise<ControlPlaneStore> {
  const env = process.env;
  const url = env.WORTHLINE_CONTROL_PLANE_DB_URL;
  if (!url) {
    throw new Error("WORTHLINE_CONTROL_PLANE_DB_URL is not configured.");
  }
  return createControlPlaneStore({
    url,
    ...(env.WORTHLINE_DB_AUTH_TOKEN ? { authToken: env.WORTHLINE_DB_AUTH_TOKEN } : {}),
  });
}

export async function withBillingControlPlaneStore<
  T,
  S extends Partial<ControlPlaneStore> = ControlPlaneStore,
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

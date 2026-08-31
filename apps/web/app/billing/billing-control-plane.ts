/**
 * El seam de control plane del billing (PRD #1160 S5, #1165). Desde #1694 es un
 * alias del helper compartido (`app/control-plane-store.ts`) con el
 * {@link ControlPlaneStore} ordinario: el webhook y las superficies de upgrade no
 * necesitan (ni deben ver) los writes de curación del catálogo. Abre desde env,
 * cierra siempre — salvo store inyectado (tests), cuyo ciclo de vida es del
 * llamante.
 *
 * Se conserva como nombre propio (en vez de importar el helper directamente en
 * cada call-site) porque «control plane del billing» es el concepto que el
 * webhook lee, y deja un sitio donde acotar la superficie si algún día el
 * billing necesita menos que el store completo.
 */

import { withControlPlaneStore } from "@web/control-plane-store";
import type { ControlPlaneStore } from "@worthline/db";

export async function withBillingControlPlaneStore<
  T,
  S extends Partial<ControlPlaneStore> = ControlPlaneStore,
>(run: (store: S) => T | Promise<T>, injectedStore?: S): Promise<T> {
  return withControlPlaneStore(run, {
    purpose: "Billing",
    ...(injectedStore ? { injectedStore } : {}),
  });
}

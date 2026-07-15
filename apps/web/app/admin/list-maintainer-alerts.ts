import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import type { ControlPlaneStore, MaintainerAlert } from "@worthline/db";

/** The maintainer-alert index for /admin (#1050): every alert (most-recently-seen first) + the open badge. */
export interface AdminMaintainerAlerts {
  alerts: MaintainerAlert[];
  openCount: number;
}

export async function listAdminMaintainerAlerts(
  injectedStore?: ControlPlaneStore,
): Promise<AdminMaintainerAlerts> {
  return withControlPlaneStore(async (store) => {
    const [alerts, openCount] = await Promise.all([
      store.listMaintainerAlerts(),
      store.countOpenMaintainerAlerts(),
    ]);
    return { alerts, openCount };
  }, injectedStore);
}

/** The open-alert badge count alone — for the /admin index without loading the full list. */
export async function countAdminOpenMaintainerAlerts(
  injectedStore?: ControlPlaneStore,
): Promise<number> {
  return withControlPlaneStore(
    (store) => store.countOpenMaintainerAlerts(),
    injectedStore,
  );
}

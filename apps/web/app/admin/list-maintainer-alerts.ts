import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import type { MaintainerAlert, MaintainerAlertLog } from "@worthline/db";

/** The maintainer-alert index for /admin (#1050): every alert (most-recently-seen first) + the open badge. */
export interface AdminMaintainerAlerts {
  alerts: MaintainerAlert[];
  openCount: number;
}

export async function listAdminMaintainerAlerts(
  injectedStore?: Pick<
    MaintainerAlertLog,
    "listMaintainerAlerts" | "countOpenMaintainerAlerts"
  >,
): Promise<AdminMaintainerAlerts> {
  return withControlPlaneStore(
    async (
      store: Pick<
        MaintainerAlertLog,
        "listMaintainerAlerts" | "countOpenMaintainerAlerts"
      >,
    ) => {
      const [alerts, openCount] = await Promise.all([
        store.listMaintainerAlerts(),
        store.countOpenMaintainerAlerts(),
      ]);
      return { alerts, openCount };
    },
    injectedStore,
  );
}

/** The open-alert badge count alone — for the /admin index without loading the full list. */
export async function countAdminOpenMaintainerAlerts(
  injectedStore?: Pick<MaintainerAlertLog, "countOpenMaintainerAlerts">,
): Promise<number> {
  return withControlPlaneStore(
    (store: Pick<MaintainerAlertLog, "countOpenMaintainerAlerts">) =>
      store.countOpenMaintainerAlerts(),
    injectedStore,
  );
}

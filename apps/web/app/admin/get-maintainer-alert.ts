import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import type { ControlPlaneStore, MaintainerAlertWithOccurrences } from "@worthline/db";

/** One maintainer alert with every occurrence's forensic payload (#1050), or null when unknown. */
export async function getAdminMaintainerAlert(
  alertId: string,
  injectedStore?: ControlPlaneStore,
): Promise<MaintainerAlertWithOccurrences | null> {
  return withControlPlaneStore(
    (store) => store.getMaintainerAlert(alertId),
    injectedStore,
  );
}

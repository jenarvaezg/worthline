import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import type { MaintainerAlertLog, MaintainerAlertWithOccurrences } from "@worthline/db";

/** One maintainer alert with every occurrence's forensic payload (#1050), or null when unknown. */
export async function getAdminMaintainerAlert(
  alertId: string,
  injectedStore?: Pick<MaintainerAlertLog, "getMaintainerAlert">,
): Promise<MaintainerAlertWithOccurrences | null> {
  return withControlPlaneStore(
    (store: Pick<MaintainerAlertLog, "getMaintainerAlert">) =>
      store.getMaintainerAlert(alertId),
    injectedStore,
  );
}

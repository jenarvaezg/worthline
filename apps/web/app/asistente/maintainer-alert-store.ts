import { withOptionalControlPlaneStore } from "@web/control-plane-store";
import type {
  MaintainerAlertCategory,
  MaintainerAlertLog,
  RaisedMaintainerAlert,
} from "@worthline/db";

/**
 * The chat route's maintainer-alert write seam (#1050, ADR 0064), mirroring
 * `provider-cooldown-store.ts`: opens a `ControlPlaneStore` from env, raises the
 * alert, and always closes it. Control-plane-only by construction — the alert
 * never touches the caller's workspace database, so no export can drag
 * maintainer material out (decision #1038).
 *
 * `null` when the control plane is not configured (local no-auth dev): the
 * assistant still repairs and answers; it simply cannot persist the alert. The
 * repair NEVER waits on the alert (framing of map #1033).
 */

export interface RaiseMaintainerAlertRequest {
  workspaceId: string;
  holdingId: string;
  category: MaintainerAlertCategory;
  payload: unknown;
  occurredAt?: string;
}

export async function raiseMaintainerAlert(
  request: RaiseMaintainerAlertRequest,
): Promise<RaisedMaintainerAlert | null> {
  return withOptionalControlPlaneStore<RaisedMaintainerAlert, MaintainerAlertLog>(
    (controlPlane) =>
      controlPlane.raiseMaintainerAlert({
        workspaceId: request.workspaceId,
        holdingId: request.holdingId,
        category: request.category,
        payload: request.payload,
        ...(request.occurredAt === undefined ? {} : { occurredAt: request.occurredAt }),
      }),
  );
}

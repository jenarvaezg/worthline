import {
  createControlPlaneStore,
  type MaintainerAlertCategory,
  type MaintainerAlertLog,
  type RaisedMaintainerAlert,
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

function controlPlaneConfig(): { url: string; authToken?: string } | null {
  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"]?.trim();
  if (!url) return null;
  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"]?.trim();
  return { url, ...(authToken ? { authToken } : {}) };
}

async function runWithControlPlane<T>(
  config: { url: string; authToken?: string },
  run: (store: MaintainerAlertLog) => Promise<T>,
): Promise<T> {
  const controlPlane = await createControlPlaneStore(config);
  try {
    return await run(controlPlane);
  } finally {
    controlPlane.close();
  }
}

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
  const config = controlPlaneConfig();
  if (!config) return null;
  return runWithControlPlane(config, (controlPlane) =>
    controlPlane.raiseMaintainerAlert({
      workspaceId: request.workspaceId,
      holdingId: request.holdingId,
      category: request.category,
      payload: request.payload,
      ...(request.occurredAt === undefined ? {} : { occurredAt: request.occurredAt }),
    }),
  );
}

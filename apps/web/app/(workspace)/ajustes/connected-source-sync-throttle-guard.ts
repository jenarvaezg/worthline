import { errorRedirectUrl } from "@web/intake";
import { readSessionEmail, readStoreTarget } from "@web/read-store-target";
import { redirect } from "next/navigation";

import {
  connectedSourceSyncPlan,
  connectedSourceSyncWindow,
} from "./connected-source-sync-throttle";
import { countConnectedSourceSync } from "./connected-source-sync-throttle-store";

export const CONNECTED_SOURCE_SYNC_RATE_LIMIT_MESSAGE =
  "Has lanzado demasiadas sincronizaciones. Espera a la próxima hora y vuelve a intentarlo.";

export async function enforceConnectedSourceSyncThrottle(
  returnUrl: string,
): Promise<void> {
  const target = await readStoreTarget();
  const plan = connectedSourceSyncPlan({
    target,
    userEmail: await readSessionEmail(),
  });

  if (plan.mode === "bypass") {
    return;
  }

  const count = await countConnectedSourceSync(
    plan.key,
    connectedSourceSyncWindow(new Date().toISOString()),
  );

  if (count !== null && count > plan.limit) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: CONNECTED_SOURCE_SYNC_RATE_LIMIT_MESSAGE,
      }),
    );
  }
}

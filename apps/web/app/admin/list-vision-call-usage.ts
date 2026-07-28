import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import {
  ADMIN_TOKEN_USAGE_WINDOW_DAYS,
  tokenUsageSinceDayKey,
} from "@web/admin/list-ai-token-usage";
import type { UsageLimits, VisionCallDailyUsage } from "@worthline/db";

/**
 * The /admin extraction spend view (#1258): the global daily count of vision
 * READINGS for the recent window, newest first.
 *
 * A second series next to the token one, never merged into it: the token meter
 * means the conversational turn (#1163) and this one means the one-shot document
 * ingestion, which is a separate model, a separate moment and a separate unit
 * (calls, not tokens). Reading them as one number would hide exactly the spend
 * that had no counter at all before this.
 *
 * Global scope only, so no demo IP ever leaves the control plane, and aggregate
 * only — the table has no column for content (#1131). The window floor is shared
 * with the token series on purpose: both tables answer "the last N days", and two
 * copies of that arithmetic would be two things to keep in step.
 */
export async function listAdminVisionCallUsage(
  nowIso: string = new Date().toISOString(),
  windowDays: number = ADMIN_TOKEN_USAGE_WINDOW_DAYS,
  injectedStore?: Pick<UsageLimits, "readRecentGlobalVisionCallUsage">,
): Promise<VisionCallDailyUsage[]> {
  const since = tokenUsageSinceDayKey(nowIso, windowDays);
  return withControlPlaneStore(
    (store: Pick<UsageLimits, "readRecentGlobalVisionCallUsage">) =>
      store.readRecentGlobalVisionCallUsage(since),
    injectedStore,
  );
}

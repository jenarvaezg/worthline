import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import type { AiDailyTokenUsage, UsageLimits } from "@worthline/db";

/** How many days of global AI spend the /admin surface shows by default. */
export const ADMIN_TOKEN_USAGE_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The floor day key (UTC "YYYY-MM-DD") for a window of `windowDays` ending on
 * the day of `nowIso`, inclusive — so a 14-day window spans today and the 13
 * days before it.
 */
export function tokenUsageSinceDayKey(nowIso: string, windowDays: number): string {
  const since = new Date(Date.parse(nowIso) - (windowDays - 1) * DAY_MS);
  return since.toISOString().slice(0, 10);
}

/**
 * The /admin AI spend view (PRD #1160 S3, #1163): the global daily token totals
 * for the recent window, newest first. Aggregate only — the metering table
 * stores no content (#1131), so this exposes the shape of the spend, never a
 * workspace's data.
 */
export async function listAdminAiTokenUsage(
  nowIso: string = new Date().toISOString(),
  windowDays: number = ADMIN_TOKEN_USAGE_WINDOW_DAYS,
  injectedStore?: Pick<UsageLimits, "readRecentGlobalAiTokenUsage">,
): Promise<AiDailyTokenUsage[]> {
  const since = tokenUsageSinceDayKey(nowIso, windowDays);
  return withControlPlaneStore(
    (store: Pick<UsageLimits, "readRecentGlobalAiTokenUsage">) =>
      store.readRecentGlobalAiTokenUsage(since),
    injectedStore,
  );
}

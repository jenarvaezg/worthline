import type { StoreTarget } from "@web/store-resolver";

/**
 * Shared-baseline chat rate limiting (ADR 0051): every request on the shared
 * provider key passes through a counter BEFORE calling the provider. The
 * counter lives in the control plane (serverless-safe); this module is the
 * pure policy half — key selection, window bucketing, limits — so it
 * unit-tests without a database.
 *
 * Fixed UTC-hour windows: a denied caller rolls over at the top of the hour.
 * The Gateway spend ceiling (ADR 0050) backstops everything.
 */

export const CHAT_RATE_LIMITS = {
  /** Authenticated usage, per workspace, per hour. */
  workspace: 30,
  /** Coarse fallback (demo or unauthenticated), per IP, per hour. */
  coarse: 10,
} as const;

export type ChatRatePlan =
  | { mode: "count"; key: string; limit: number }
  | { mode: "bypass" };

/** The ISO timestamp's fixed UTC-hour window key, e.g. "2026-07-04T10". */
export function chatRateWindow(nowIso: string): string {
  return nowIso.slice(0, 13);
}

/**
 * How to meter this request: which counter key and limit, or bypass for the
 * local single-user target where the developer owns the key (ADR 0051).
 */
export function chatRatePlan(target: StoreTarget, ip: string | null): ChatRatePlan {
  switch (target.kind) {
    case "local":
      return { mode: "bypass" };
    case "authenticated":
      return {
        mode: "count",
        key: `ws:${target.workspaceId}`,
        limit: CHAT_RATE_LIMITS.workspace,
      };
    case "demo":
      return {
        mode: "count",
        key: `demo:${ip ?? "unknown"}`,
        limit: CHAT_RATE_LIMITS.coarse,
      };
    case "unauthenticated":
      return {
        mode: "count",
        key: `ip:${ip ?? "unknown"}`,
        limit: CHAT_RATE_LIMITS.coarse,
      };
  }
}

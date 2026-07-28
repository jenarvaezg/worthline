import { type CallerScope, callerScope } from "@web/asistente/caller-scope";
import type { StoreTarget } from "@web/store-resolver";

/**
 * Shared-baseline chat rate limiting (ADR 0051): every request on the shared
 * provider key passes through a counter BEFORE calling the provider. The
 * counter lives in the control plane (serverless-safe); this module is the
 * pure policy half — key selection, window bucketing, limits — so it
 * unit-tests without a database.
 *
 * Fixed UTC-hour windows: a denied caller rolls over at the top of the hour.
 *
 * ADR 0050's Vercel AI Gateway spend ceiling is a platform-level backstop on
 * hosted provider traffic. Production today calls each admitted provider
 * directly through the AI SDK factories (BYOK keys in env); the gateway ceiling
 * is configured in the Vercel AI Gateway console when routing through the
 * gateway, and is not a substitute for the per-IP or demo-global limits here.
 */

export const CHAT_RATE_LIMITS = {
  /** Authenticated usage, per workspace, per hour. */
  workspace: 30,
  /** Coarse fallback (demo or unauthenticated), per IP, per hour. */
  coarse: 5,
  /**
   * Demo traffic aggregate, all IPs combined, per hour (#1184). Stops a botnet
   * from multiplying the per-IP ceiling; each demo turn increments both buckets.
   */
  demoGlobal: 60,
} as const;

export type ChatRatePlan =
  | { mode: "count"; key: string; limit: number }
  | Extract<CallerScope, { mode: "bypass" }>;

/** The ISO timestamp's fixed UTC-hour window key, e.g. "2026-07-04T10". */
export function chatRateWindow(nowIso: string): string {
  return nowIso.slice(0, 13);
}

/**
 * How to meter this request: which counter key and limit, or bypass for the
 * local single-user target where the developer owns the key (ADR 0051). The key
 * itself comes from `callerScope`, shared with every other meter over the shared
 * provider key; only the limits are this module's.
 */
export function chatRatePlan(target: StoreTarget, ip: string | null): ChatRatePlan {
  const scope = callerScope(target, ip);
  if (scope.mode === "bypass") return scope;
  return {
    mode: "count",
    key: scope.key,
    limit:
      target.kind === "authenticated"
        ? CHAT_RATE_LIMITS.workspace
        : CHAT_RATE_LIMITS.coarse,
  };
}

/** Shared hourly bucket for all anonymous demo assistant traffic (#1184). */
export function demoGlobalRatePlan(): Extract<ChatRatePlan, { mode: "count" }> {
  return {
    mode: "count",
    key: "demo:global",
    limit: CHAT_RATE_LIMITS.demoGlobal,
  };
}

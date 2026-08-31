import {
  controlPlaneTargetFromEnv,
  withOptionalControlPlaneStore,
} from "@web/control-plane-store";
import type { UsageLimits } from "@worthline/db";

import type { McpRatePlan } from "./rate-limit";
import { mcpRateWindow } from "./rate-limit";

/**
 * MCP/OAuth rate-limit persistence (#1183). Returns null when no control-plane
 * URL is configured (local dev, unmetered). Throws on store errors — callers
 * that must fail closed catch and reject without downstream WorkOS/DB calls.
 */
export async function countMcpRequest(
  rateKey: string,
  windowKey: string,
): Promise<number | null> {
  return withOptionalControlPlaneStore<number, Pick<UsageLimits, "recordMcpRequest">>(
    (controlPlane) => controlPlane.recordMcpRequest(rateKey, windowKey),
  );
}

export type EnforceMcpRateLimitOutcome = "ok" | "limited" | "store_unavailable";

/** Increment-then-check. Fail-closed when the store is configured but unavailable. */
export async function enforceMcpRateLimit(
  plan: McpRatePlan,
): Promise<EnforceMcpRateLimitOutcome> {
  if (plan.mode === "bypass") {
    return "ok";
  }

  // Unmetered local dev is `ok`, not `store_unavailable`: there is no store to be
  // unavailable. Probed before the count so the two nulls stay distinguishable.
  if (!controlPlaneTargetFromEnv()) {
    return "ok";
  }

  try {
    const count = await countMcpRequest(
      plan.key,
      mcpRateWindow(new Date().toISOString()),
    );
    if (count === null) {
      return "store_unavailable";
    }
    return count > plan.limit ? "limited" : "ok";
  } catch (error) {
    console.error("MCP rate limit store failed", {
      operation: "record",
      cause:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { message: String(error) },
    });
    return "store_unavailable";
  }
}

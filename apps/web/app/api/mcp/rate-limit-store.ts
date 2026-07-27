import { createControlPlaneStore, type UsageLimits } from "@worthline/db";

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
  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  if (!url) {
    return null;
  }

  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"];
  const controlPlane: Pick<UsageLimits, "recordMcpRequest"> & { close(): void } =
    await createControlPlaneStore({
      url,
      ...(authToken ? { authToken } : {}),
    });
  try {
    return await controlPlane.recordMcpRequest(rateKey, windowKey);
  } finally {
    controlPlane.close();
  }
}

export type EnforceMcpRateLimitOutcome = "ok" | "limited" | "store_unavailable";

/** Increment-then-check. Fail-closed when the store is configured but unavailable. */
export async function enforceMcpRateLimit(
  plan: McpRatePlan,
): Promise<EnforceMcpRateLimitOutcome> {
  if (plan.mode === "bypass") {
    return "ok";
  }

  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  if (!url) {
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

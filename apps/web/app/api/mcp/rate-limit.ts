import { CHAT_RATE_LIMITS, chatRateWindow } from "@web/asistente/rate-limit";

/**
 * MCP + OAuth callback rate limiting (#1183): mirrors the chat policy (ADR 0051)
 * with separate counter keys so assistant and MCP quotas do not interfere.
 *
 * Pre-auth traffic is keyed by IP (coarse limit). After JWT verification the
 * WorkOS subject gets the workspace-equivalent limit — before any WorkOS userinfo
 * lookup or control-plane workspace resolution.
 */

export const MCP_RATE_LIMITS = {
  /** Authenticated MCP usage, per subject, per hour. */
  subject: CHAT_RATE_LIMITS.workspace,
  /** Pre-auth fallback (invalid-token bursts, OAuth callbacks), per IP, per hour. */
  coarse: CHAT_RATE_LIMITS.coarse,
} as const;

export type McpRatePlan =
  | { mode: "count"; key: string; limit: number }
  | { mode: "bypass" };

/** Fixed UTC-hour window — same bucketing as chat. */
export const mcpRateWindow = chatRateWindow;

/** Pre-auth IP bucket, applied before JWT verification or OAuth handler work. */
export function mcpPreAuthRatePlan(ip: string | null): McpRatePlan {
  return {
    mode: "count",
    key: `mcp:ip:${ip ?? "unknown"}`,
    limit: MCP_RATE_LIMITS.coarse,
  };
}

/** Post-JWT subject bucket, applied before resolveEmail / resolveWorkspace. */
export function mcpSubjectRatePlan(subject: string): McpRatePlan {
  return {
    mode: "count",
    key: `mcp:sub:${subject}`,
    limit: MCP_RATE_LIMITS.subject,
  };
}

/** Auth.js OAuth callback traffic — own key namespace, same coarse limit. */
export function authOAuthRatePlan(ip: string | null): McpRatePlan {
  return {
    mode: "count",
    key: `auth:ip:${ip ?? "unknown"}`,
    limit: MCP_RATE_LIMITS.coarse,
  };
}

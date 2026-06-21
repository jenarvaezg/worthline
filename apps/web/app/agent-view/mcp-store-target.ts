import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { resolveStoreTarget, type StoreTarget } from "@web/store-resolver";

/**
 * The StoreTarget for an MCP request, derived from a verified token's AuthInfo,
 * or undefined when the token carries no workspace claim (ADR 0034). The token's
 * workspace — set by `verifyMcpToken` from the control plane — flows through the
 * same pure `resolveStoreTarget` the pages and server actions use, so "which
 * workspace this request opens" is decided in one place. The OAuth token that
 * identified the caller never reaches the store seam; the env Turso group token
 * inside the returned target is what opens the database.
 */
export function storeTargetFromMcpAuth(
  authInfo: AuthInfo | undefined,
): StoreTarget | undefined {
  // No token ⇒ not the OAuth path (demo persona cookie / local no-auth); the
  // caller falls back to its own resolution.
  if (!authInfo) return undefined;

  const extra = authInfo.extra;
  const workspaceId =
    typeof extra?.["workspaceId"] === "string" ? extra["workspaceId"] : null;
  const dbUrl = typeof extra?.["dbUrl"] === "string" ? extra["dbUrl"] : null;
  if (!workspaceId || !dbUrl) {
    // A verified token MUST carry a usable workspace (verifyMcpToken sets both
    // from the control plane). Missing/malformed claims mean a verifier or
    // control-plane fault — fail loud rather than silently degrade an
    // authenticated caller to demo/stub data (which would read as "no data").
    throw new Error("MCP token is missing usable workspace claims (workspaceId/dbUrl).");
  }
  return resolveStoreTarget({
    env: process.env,
    session: null,
    mcpWorkspace: { workspaceId, dbUrl },
  });
}

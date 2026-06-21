import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Resolve a bearer token presented to the agent-view MCP endpoint into the MCP
 * {@link AuthInfo} that identifies the caller's workspace (PRD #438, ADR 0034).
 *
 * S1 (#439) ships the OAuth *discovery* handshake only: this stub rejects every
 * token regardless of input, so an unauthenticated/invalid request gets a 401
 * pointing at the protected-resource metadata. S2 (#440) replaces the body with
 * real validation — JWT signature against the Authorization Server's JWKS,
 * issuer, audience (the worthline resource id), expiry, and subject→workspace
 * mapping via the control plane — and takes the `(req, bearerToken)` arguments
 * `withMcpAuth` passes (a narrower no-arg signature is assignable to the wider
 * `verifyToken` type it expects).
 */
export async function verifyMcpToken(): Promise<AuthInfo | undefined> {
  return undefined;
}

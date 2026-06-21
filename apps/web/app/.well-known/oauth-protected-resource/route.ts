import { metadataCorsOptionsRequestHandler, protectedResourceHandler } from "mcp-handler";

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata for the agent-view MCP endpoint
 * (PRD #438, ADR 0034). An MCP client (claude.ai / Claude Code) fetches this
 * before it has a session to learn (a) that `/api/mcp` is an OAuth-protected
 * resource and (b) which Authorization Server to authorize against. Serving
 * parseable JSON here — and a 401 pointing at it from `/api/mcp` — is what turns
 * the client's "Failed to parse JSON" into a real OAuth discovery.
 *
 * `resource` is worthline's public HTTPS origin, derived by `protectedResourceHandler`
 * from proxy headers (X-Forwarded-Host/Proto on Vercel), never the internal URL.
 * `authorization_servers` is env-driven (WorkOS lands in S4 / #442); a placeholder
 * keeps the metadata shape valid until then.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PLACEHOLDER_AUTH_SERVER = "https://authorization-server.invalid/oauth";

function authServerUrls(): string[] {
  const configured = process.env.WORTHLINE_MCP_AUTH_SERVER_URL?.trim();
  return [configured && configured.length > 0 ? configured : PLACEHOLDER_AUTH_SERVER];
}

export function GET(req: Request): Response {
  return protectedResourceHandler({ authServerUrls: authServerUrls() })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();

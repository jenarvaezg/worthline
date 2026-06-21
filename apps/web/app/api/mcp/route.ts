import { createMcpHandler, withMcpAuth } from "mcp-handler";

import { createAgentViewInternalMcpToolCatalog } from "@web/agent-view/internal-catalog";
import { createAgentViewMcpServer } from "@web/agent-view/mcp-server";

import { verifyMcpToken } from "./verify-token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MCP_METADATA_PATH = "/.well-known/oauth-protected-resource";
const MCP_READ_SCOPE = "worthline:read";

const baseHandler = createMcpHandler(
  createAgentViewMcpServer(createAgentViewInternalMcpToolCatalog()),
  {
    capabilities: { tools: {} },
    serverInfo: { name: "worthline", version: "0.1.0" },
  },
  {
    basePath: "/api",
    disableSse: true,
    maxDuration: 60,
  },
);

// On the hosted deploy the endpoint is an OAuth 2.1 protected resource: an
// unauthenticated/invalid request returns 401 + `WWW-Authenticate: Bearer …
// resource_metadata="…"`, which is what turns an MCP client's "Failed to parse
// JSON" into a real OAuth discovery (ADR 0034). `verifyMcpToken` rejects every
// token in S1 — the valid-token path arrives in S2 (#440).
const gatedHandler = withMcpAuth(baseHandler, verifyMcpToken, {
  required: true,
  resourceMetadataPath: MCP_METADATA_PATH,
  requiredScopes: [MCP_READ_SCOPE],
});

function isAuthConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

// Gate only the hosted multi-tenant deploy. The local no-auth mode and the
// logged-out demo (persona cookie) MCP paths stay open and unchanged, mirroring
// `resolveStoreTarget`'s `authConfigured` short-circuit (ADR 0030/0034).
function handler(req: Request): Promise<Response> {
  return isAuthConfigured() ? gatedHandler(req) : baseHandler(req);
}

export { handler as GET, handler as POST };

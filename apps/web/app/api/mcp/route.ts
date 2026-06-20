import { createMcpHandler } from "mcp-handler";

import { createAgentViewInternalMcpToolCatalog } from "@web/agent-view/internal-catalog";
import { createAgentViewMcpServer } from "@web/agent-view/mcp-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createMcpHandler(
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

export { handler as GET, handler as POST };

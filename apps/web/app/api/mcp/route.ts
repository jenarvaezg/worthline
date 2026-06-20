import { createMcpHandler } from "mcp-handler";

import { createAgentViewMcpServer } from "@web/agent-view/mcp-server";
import { createStubAgentViewMcpToolCatalog } from "@web/agent-view/stub-catalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createMcpHandler(
  createAgentViewMcpServer(createStubAgentViewMcpToolCatalog()),
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

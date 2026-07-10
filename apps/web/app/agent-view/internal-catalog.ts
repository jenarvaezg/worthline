import { readDemoContext } from "@web/demo/read-demo-context";
import { withStore } from "@web/store";
import { type AgentViewReadStore } from "@worthline/db";

import { type AgentViewCatalogTool, createAgentViewCatalog } from "./catalog";
import type { AgentViewMcpServerTool, AgentViewToolContext } from "./mcp-server";
import { storeTargetFromMcpAuth } from "./mcp-store-target";
import { createReadStoreBackend } from "./read-backend";
import { STUB_NOTICE } from "./stub-catalog";

const STUB_RESPONSE = { data: { notice: STUB_NOTICE } };

/**
 * Run one catalog tool against the store the request is bound to. An
 * OAuth-authenticated MCP request (ADR 0034) carries a token whose AuthInfo
 * resolves to exactly one workspace — the read (and its default-scope
 * resolution) runs against *that* workspace's database in a single binding. With
 * no token the catalog keeps its prior behavior: the logged-out demo (persona
 * cookie) returns real demo data, and any other context (local no-auth dev)
 * returns the not-yet-wired stub.
 */
async function runCatalogTool(
  tool: AgentViewCatalogTool<unknown, unknown>,
  input: unknown,
  context: AgentViewToolContext,
): Promise<unknown> {
  const run = (agentView: AgentViewReadStore) =>
    tool.run(input, createReadStoreBackend(agentView));

  const target = storeTargetFromMcpAuth(context.authInfo);
  if (target) {
    return withStore((store) => run(store.agentView), target);
  }

  const demo = await readDemoContext();
  if (!demo.enabled) return STUB_RESPONSE;
  return withStore((store) => run(store.agentView));
}

/**
 * Build the agent-view tool catalog for the public MCP endpoint (#576) bound to
 * the internal read store. Tool names, descriptions, and input schemas come from
 * the single catalog definition in `catalog.ts`; each tool's read runs in-process
 * against the token-bound (or demo) read store.
 */
export function createAgentViewInternalMcpToolCatalog(): AgentViewMcpServerTool[] {
  const catalog = createAgentViewCatalog();
  return Object.values(catalog).map((entry) => {
    const tool = entry as AgentViewCatalogTool<unknown, unknown>;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      invoke: (input, context) => runCatalogTool(tool, input, context),
    };
  });
}

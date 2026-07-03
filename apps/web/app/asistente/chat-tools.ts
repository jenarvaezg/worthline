import { jsonSchema, tool, type ToolSet } from "ai";

import type { AgentViewReadStore } from "@worthline/db";

import { buildFinancialContext } from "@web/agent-view/financial-context";
import { listAgentViewScopes } from "@web/agent-view/scopes";

/**
 * The assistant's chat tools (#629, ADR 0047): thin conversational wrappers
 * over the agent-view services. Calculation logic stays in agent-view; the
 * model never defines its own net-worth formula.
 *
 * Writes are impossible by construction: tools receive ONLY the read store
 * (`agentView`) — the write API never crosses this boundary (ADR 0044).
 */

export interface ChatReadStore {
  agentView: AgentViewReadStore;
}

export interface ChatToolsInput {
  /** Runs a read against the caller's workspace (tenant already resolved). */
  runWithStore: <T>(run: (store: ChatReadStore) => Promise<T>) => Promise<T>;
  /** YYYY-MM-DD valuation date — the demo clock for demo targets. */
  asOf: string;
}

/** Holdings included in the chat payload — enough to reason, cheap in tokens. */
const CHAT_HOLDING_LIMIT = 10;

export function createChatTools({ runWithStore, asOf }: ChatToolsInput): ToolSet {
  return {
    get_financial_context: tool({
      description:
        "Lee la foto financiera actual del workspace (patrimonio neto, líquido, deudas, " +
        "exposición, calidad de datos, FIRE) del scope por defecto. Es la fuente canónica " +
        "de cifras: no calcules patrimonio por tu cuenta. Incluye `links` con las fuentes " +
        "internas citables.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () =>
        runWithStore(async (store) => {
          const scopes = await listAgentViewScopes(store.agentView);
          const scope = scopes.find((s) => s.isDefault) ?? scopes[0];
          if (!scope) {
            // ADR 0048: say the fact is missing rather than invent one.
            return { error: "empty_workspace" };
          }

          return buildFinancialContext(store.agentView, {
            scopeId: scope.id,
            asOf,
            holdingLimit: CHAT_HOLDING_LIMIT,
          });
        }),
    }),
  };
}

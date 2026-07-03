import { jsonSchema, tool, type ToolSet } from "ai";

import type { AgentViewReadStore } from "@worthline/db";
import { formatMoneyMinor } from "@worthline/domain";

import type { AgentViewFinancialContext } from "@web/agent-view/contract";
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

/**
 * The agent-view context reshaped for conversation (ADR 0047): every amount
 * becomes a PRE-FORMATTED es-ES string. The raw contract carries amountMinor
 * (céntimos) — a chat model recites those as euros (the #629 smoke bug:
 * «1.258.499 euros» for a 12.585 € liquid net worth). Formatting here also
 * trims the payload for the free tier's tokens-per-minute budget.
 */
function toChatFinancialContext(context: AgentViewFinancialContext) {
  return {
    asOf: context.asOf,
    baseCurrency: context.baseCurrency,
    scope: { id: context.scope.id, label: context.scope.label },
    summary: {
      netWorth: formatMoneyMinor(context.summary.netWorth),
      liquidNetWorth: formatMoneyMinor(context.summary.liquidNetWorth),
      grossAssets: formatMoneyMinor(context.summary.grossAssets),
      debts: formatMoneyMinor(context.summary.debts),
      housingEquity: formatMoneyMinor(context.summary.housingEquity),
    },
    liquidity: context.liquidityBreakdown.map((rung) => ({
      tier: rung.tier,
      netValue: formatMoneyMinor(rung.netValue),
      grossAssets: formatMoneyMinor(rung.grossAssets),
      debts: formatMoneyMinor(rung.debts),
      shareOfGross: rung.shareOfGross,
    })),
    holdings: context.holdings.items.map((holding) => ({
      label: holding.label,
      instrument: holding.instrument,
      direction: holding.direction,
      liquidityTier: holding.liquidityTier,
      currentValue: formatMoneyMinor(holding.currentValue),
    })),
    omittedHoldings:
      context.holdings.omittedCount > 0
        ? {
            count: context.holdings.omittedCount,
            totalValue: formatMoneyMinor(context.holdings.omittedTotalValue),
          }
        : null,
    links: context.links,
  };
}

export function createChatTools({ runWithStore, asOf }: ChatToolsInput): ToolSet {
  return {
    get_financial_context: tool({
      description:
        "Lee la foto financiera actual del workspace (patrimonio neto, líquido, deudas, " +
        "desglose de liquidez y principales posiciones) del scope por defecto. Es la " +
        "fuente canónica de cifras y los importes llegan YA FORMATEADOS como strings " +
        "es-ES: cítalos tal cual, no los recalcules. Incluye `links` con las fuentes " +
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

          return toChatFinancialContext(
            await buildFinancialContext(store.agentView, {
              scopeId: scope.id,
              asOf,
              holdingLimit: CHAT_HOLDING_LIMIT,
            }),
          );
        }),
    }),
  };
}

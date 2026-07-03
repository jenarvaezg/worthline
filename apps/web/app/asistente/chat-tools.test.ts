/**
 * Chat tool boundary tests (#629, ADR 0047): the assistant's read tool
 * resolves real facts through the agent-view layer — same figures the
 * dashboard computes — and cannot write because it only ever sees the
 * read store. Seeded like seed-persona.test.ts (in-memory store, familia).
 */
import { describe, expect, it } from "vitest";

import { createInMemoryStore } from "@worthline/db";
import { formatMoneyMinor } from "@worthline/domain";

import { buildFinancialContext } from "@web/agent-view/financial-context";
import { listAgentViewScopes } from "@web/agent-view/scopes";
import { createChatTools } from "@web/asistente/chat-tools";
import { seedPersona } from "@web/demo/seed-persona";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";

const AS_OF = "2026-06-19";
const SEED_TIMEOUT_MS = 15_000;

async function seededStore() {
  const store = await createInMemoryStore();
  await seedPersona(store, FAMILIA_SPEC, AS_OF);
  return store;
}

describe("createChatTools · get_financial_context", () => {
  it(
    "reads the default scope's real figures through the agent-view boundary, with source links",
    async () => {
      const store = await seededStore();
      const tools = createChatTools({
        runWithStore: (run) => run({ agentView: store.agentView }),
        asOf: AS_OF,
      });

      const tool = tools["get_financial_context"];
      expect(tool).toBeDefined();
      const result = await tool?.execute?.({}, toolCallContext());

      const scopes = await listAgentViewScopes(store.agentView);
      const defaultScope = scopes.find((s) => s.isDefault) ?? scopes[0];
      const expected = await buildFinancialContext(store.agentView, {
        scopeId: defaultScope?.id ?? "",
        asOf: AS_OF,
        holdingLimit: 10,
      });

      // Amounts arrive FORMATTED (es-ES strings): a model reading raw
      // amountMinor recites céntimos as euros — the #629 smoke bug.
      expect(result.summary.netWorth).toBe(formatMoneyMinor(expected.summary.netWorth));
      expect(result.summary.netWorth).toMatch(/€/);
      expect(JSON.stringify(result)).not.toContain("amountMinor");

      expect(result.scope.id).toBe(defaultScope?.id);
      expect(result.liquidity.length).toBeGreaterThan(0);
      expect(result.holdings.length).toBeGreaterThan(0);
      expect(Object.keys(result.links).length).toBeGreaterThan(0);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "mutates nothing observable in the workspace",
    async () => {
      const store = await seededStore();
      const scopes = await listAgentViewScopes(store.agentView);
      const scopeId = (scopes.find((s) => s.isDefault) ?? scopes[0])?.id ?? "";
      const before = await buildFinancialContext(store.agentView, {
        scopeId,
        asOf: AS_OF,
      });

      const tools = createChatTools({
        runWithStore: (run) => run({ agentView: store.agentView }),
        asOf: AS_OF,
      });
      await tools["get_financial_context"]?.execute?.({}, toolCallContext());

      const after = await buildFinancialContext(store.agentView, {
        scopeId,
        asOf: AS_OF,
      });
      expect(after).toEqual(before);
    },
    SEED_TIMEOUT_MS,
  );

  it("reports an empty workspace instead of inventing figures", async () => {
    const store = await createInMemoryStore();
    const tools = createChatTools({
      runWithStore: (run) => run({ agentView: store.agentView }),
      asOf: AS_OF,
    });

    const result = await tools["get_financial_context"]?.execute?.({}, toolCallContext());

    expect(result).toEqual({ error: "empty_workspace" });
  });
});

/** Minimal execution options the AI SDK passes to execute — unused by our tools. */
function toolCallContext(): never {
  return { toolCallId: "call-1", messages: [] } as unknown as never;
}

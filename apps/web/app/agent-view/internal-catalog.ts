import type { AgentViewReadStore } from "@worthline/db";
import { systemClock } from "@worthline/domain";

import { readDemoContext } from "@web/demo/read-demo-context";
import { withStore } from "@web/store";

import {
  successEnvelope,
  type AgentViewDataQualityCategory,
  type AgentViewDataQualitySeverity,
} from "./contract";
import {
  buildHoldingConnectedSourcePositions,
  buildSourceConnectedSourcePositions,
} from "./connected-source-positions";
import { buildDataQuality } from "./data-quality";
import { buildFigureExplanation, isFigureName } from "./figure-explanations";
import { buildFinancialContext } from "./financial-context";
import { buildFireContext } from "./fire-context";
import { buildHoldingDetail } from "./holding-detail";
import { buildHoldingOperations } from "./holding-operations";
import type { AgentViewMcpServerTool } from "./mcp-server";
import { createStubAgentViewMcpToolCatalog, STUB_NOTICE } from "./stub-catalog";
import { listAgentViewScopes } from "./scopes";
import { buildSnapshotHistory } from "./snapshot-history";
import { buildTrashSummary } from "./trash-summary";

const STUB_RESPONSE = { data: { notice: STUB_NOTICE } };

async function defaultScopeId(agentView: AgentViewReadStore): Promise<string> {
  const scopes = await listAgentViewScopes(agentView);
  const household = scopes.find((scope) => scope.isDefault) ?? scopes[0];
  if (!household) {
    throw new Error("No agent-view scopes are available.");
  }
  return household.id;
}

export function createAgentViewInternalMcpToolCatalog(): AgentViewMcpServerTool[] {
  const stubs = createStubAgentViewMcpToolCatalog();
  const stubsByName = Object.fromEntries(
    stubs.map((tool) => [tool.name, tool]),
  ) as Record<string, AgentViewMcpServerTool>;

  function tool(
    name: string,
    invoke: (input: unknown) => Promise<unknown>,
  ): AgentViewMcpServerTool {
    const stub = stubsByName[name];
    if (!stub) {
      throw new Error(`Unknown agent-view tool: ${name}`);
    }
    return {
      description: stub.description,
      inputSchema: stub.inputSchema,
      name: stub.name,
      invoke,
    };
  }

  return [
    tool("list_scopes", async () => {
      const demo = await readDemoContext();
      if (!demo.enabled) return STUB_RESPONSE;
      return withStore(async (store) =>
        successEnvelope(await listAgentViewScopes(store.agentView)),
      );
    }),
    tool("get_financial_context", async (raw) => {
      const demo = await readDemoContext();
      if (!demo.enabled) return STUB_RESPONSE;
      const input = raw as { scopeId?: string; holdingLimit?: number };
      return withStore(async (store) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(store.agentView));
        const context = await buildFinancialContext(store.agentView, {
          asOf: systemClock().today(),
          holdingLimit: input.holdingLimit,
          scopeId,
        });
        return successEnvelope(context);
      });
    }),
    tool("get_fire_context", async (raw) => {
      const demo = await readDemoContext();
      if (!demo.enabled) return STUB_RESPONSE;
      const input = raw as { scopeId?: string };
      return withStore(async (store) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(store.agentView));
        const context = await buildFireContext(store.agentView, { scopeId });
        return successEnvelope(context);
      });
    }),
    tool("explain_figure", async (raw) => {
      const demo = await readDemoContext();
      if (!demo.enabled) return STUB_RESPONSE;
      const input = raw as {
        figure: string;
        scopeId?: string;
        holdingId?: string;
        date?: string;
      };
      const figure = input.figure;
      if (!isFigureName(figure)) {
        return { error: { code: "bad_request", message: `Unknown figure: ${figure}` } };
      }
      return withStore(async (store) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(store.agentView));
        const explanation = await buildFigureExplanation(store.agentView, {
          asOf: systemClock().today(),
          figure,
          holdingId: input.holdingId,
          scopeId,
          ...(input.date === undefined ? {} : { date: input.date }),
        });
        return successEnvelope(explanation);
      });
    }),
    tool("get_snapshot_history", async (raw) => {
      const demo = await readDemoContext();
      if (!demo.enabled) return STUB_RESPONSE;
      const input = raw as {
        scopeId?: string;
        granularity?: "monthly-close" | "raw";
        from?: string;
        to?: string;
        sort?: "date" | "-date";
        limit?: number;
        cursor?: string;
        includeHoldingRows?: "none" | "summary" | "full";
      };
      return withStore(async (store) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(store.agentView));
        const history = await buildSnapshotHistory(store.agentView, {
          scopeId,
          cursor: input.cursor,
          from: input.from,
          granularity: input.granularity ?? "monthly-close",
          includeHoldingRows: input.includeHoldingRows ?? "none",
          limit: clampLimit(input.limit, 500),
          sort: input.sort ?? "date",
          to: input.to,
        });
        return { data: history.entries, meta: history.meta };
      });
    }),
    tool("get_data_quality", async (raw) => {
      const demo = await readDemoContext();
      if (!demo.enabled) return STUB_RESPONSE;
      const input = raw as {
        scopeId?: string;
        category?: string;
        severity?: string;
        limit?: number;
        cursor?: string;
      };
      return withStore(async (store) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(store.agentView));
        const page = await buildDataQuality(store.agentView, {
          scopeId,
          cursor: input.cursor,
          limit: clampLimit(input.limit, 500),
          ...(input.category === undefined
            ? {}
            : { category: input.category as AgentViewDataQualityCategory }),
          ...(input.severity === undefined
            ? {}
            : { severity: input.severity as AgentViewDataQualitySeverity }),
        });
        return { data: page.signals, meta: page.meta };
      });
    }),
    tool("get_trash_summary", async (raw) => {
      const demo = await readDemoContext();
      if (!demo.enabled) return STUB_RESPONSE;
      const input = raw as { scopeId?: string; limit?: number; cursor?: string };
      return withStore(async (store) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(store.agentView));
        const summary = await buildTrashSummary(store.agentView, {
          scopeId,
          cursor: input.cursor,
          limit: clampLimit(input.limit, 500),
        });
        return { data: summary.holdings, meta: summary.meta };
      });
    }),
    tool("get_holding_detail", async (raw) => {
      const demo = await readDemoContext();
      if (!demo.enabled) return STUB_RESPONSE;
      const input = raw as { holdingId: string };
      return withStore(async (store) =>
        successEnvelope(await buildHoldingDetail(store.agentView, input.holdingId)),
      );
    }),
    tool("get_operations", async (raw) => {
      const demo = await readDemoContext();
      if (!demo.enabled) return STUB_RESPONSE;
      const input = raw as {
        holdingId: string;
        from?: string;
        to?: string;
        sort?: "date" | "-date";
        limit?: number;
        cursor?: string;
      };
      return withStore(async (store) => {
        const page = await buildHoldingOperations(store.agentView, {
          holdingId: input.holdingId,
          cursor: input.cursor,
          from: input.from,
          limit: clampLimit(input.limit, 500),
          sort: input.sort ?? "-date",
          to: input.to,
        });
        return { data: page.operations, meta: page.meta };
      });
    }),
    tool("get_connected_source_positions", async (raw) => {
      const demo = await readDemoContext();
      if (!demo.enabled) return STUB_RESPONSE;
      const input = raw as {
        holdingId?: string;
        sourceId?: string;
        limit?: number;
        cursor?: string;
      };
      const hasHolding = input.holdingId !== undefined;
      const hasSource = input.sourceId !== undefined;
      if (hasHolding === hasSource) {
        return {
          error: {
            code: "unprocessable_entity",
            message:
              "Supply exactly one of holdingId or sourceId for connected-source positions.",
          },
        };
      }
      return withStore(async (store) => {
        const limit = clampLimit(input.limit, 500);
        if (input.holdingId !== undefined) {
          const page = await buildHoldingConnectedSourcePositions(store.agentView, {
            holdingId: input.holdingId,
            cursor: input.cursor,
            limit,
          });
          return { data: page.positions, meta: page.meta };
        }
        const page = await buildSourceConnectedSourcePositions(store.agentView, {
          sourceId: input.sourceId!,
          cursor: input.cursor,
          limit,
        });
        return { data: page.groups, meta: page.meta };
      });
    }),
  ];
}

function clampLimit(limit: number | undefined, max: number): number {
  if (limit === undefined) return 100;
  if (!Number.isFinite(limit) || limit < 1) return 100;
  return Math.min(limit, max);
}

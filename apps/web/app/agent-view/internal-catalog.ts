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
import { buildConnectedSourcesList, buildSourceFreshness } from "./connected-sources";
import { buildDataQuality } from "./data-quality";
import { buildFigureExplanation, isFigureName } from "./figure-explanations";
import { buildFinancialContext } from "./financial-context";
import { buildFireContext } from "./fire-context";
import { buildHoldingDetail } from "./holding-detail";
import { buildHoldingOperations } from "./holding-operations";
import { storeTargetFromMcpAuth } from "./mcp-store-target";
import { buildPriceFreshness } from "./price-freshness";
import type { AgentViewMcpServerTool, AgentViewToolContext } from "./mcp-server";
import { createStubAgentViewMcpToolCatalog, STUB_NOTICE } from "./stub-catalog";
import { listAgentViewScopes } from "./scopes";
import { buildSnapshotHistory } from "./snapshot-history";
import { buildTrashSummary } from "./trash-summary";
import { buildWarningOverrides, buildWorkspaceInfo } from "./workspace-context";

const STUB_RESPONSE = { data: { notice: STUB_NOTICE } };

async function defaultScopeId(agentView: AgentViewReadStore): Promise<string> {
  const scopes = await listAgentViewScopes(agentView);
  const household = scopes.find((scope) => scope.isDefault) ?? scopes[0];
  if (!household) {
    throw new Error("No agent-view scopes are available.");
  }
  return household.id;
}

/**
 * Run an agent-view read against the store the request is bound to. An
 * OAuth-authenticated MCP request (ADR 0034) carries a token whose AuthInfo
 * resolves to exactly one workspace — every read runs against *that* workspace's
 * database. With no token the catalog keeps its prior behavior: the logged-out
 * demo (persona cookie) returns real demo data, and any other context (local
 * no-auth dev) returns the not-yet-wired stub.
 */
async function runAgentView(
  context: AgentViewToolContext,
  run: (agentView: AgentViewReadStore) => Promise<unknown>,
): Promise<unknown> {
  const target = storeTargetFromMcpAuth(context.authInfo);
  if (target) {
    return withStore((store) => run(store.agentView), target);
  }

  const demo = await readDemoContext();
  if (!demo.enabled) return STUB_RESPONSE;
  return withStore((store) => run(store.agentView));
}

export function createAgentViewInternalMcpToolCatalog(): AgentViewMcpServerTool[] {
  const stubs = createStubAgentViewMcpToolCatalog();
  const stubsByName = Object.fromEntries(
    stubs.map((tool) => [tool.name, tool]),
  ) as Record<string, AgentViewMcpServerTool>;

  function tool(
    name: string,
    invoke: (input: unknown, context: AgentViewToolContext) => Promise<unknown>,
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
    tool("list_scopes", (_input, context) =>
      runAgentView(context, async (agentView) =>
        successEnvelope(await listAgentViewScopes(agentView)),
      ),
    ),
    tool("get_financial_context", (raw, context) => {
      const input = raw as { scopeId?: string; holdingLimit?: number };
      return runAgentView(context, async (agentView) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(agentView));
        const result = await buildFinancialContext(agentView, {
          asOf: systemClock().today(),
          holdingLimit: input.holdingLimit,
          scopeId,
        });
        return successEnvelope(result);
      });
    }),
    tool("get_fire_context", (raw, context) => {
      const input = raw as { scopeId?: string };
      return runAgentView(context, async (agentView) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(agentView));
        const result = await buildFireContext(agentView, { scopeId });
        return successEnvelope(result);
      });
    }),
    tool("explain_figure", async (raw, context) => {
      const input = raw as {
        figure: string;
        scopeId?: string;
        holdingId?: string;
        date?: string;
      };
      if (!isFigureName(input.figure)) {
        return {
          error: { code: "bad_request", message: `Unknown figure: ${input.figure}` },
        };
      }
      const figure = input.figure;
      return runAgentView(context, async (agentView) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(agentView));
        const explanation = await buildFigureExplanation(agentView, {
          asOf: systemClock().today(),
          figure,
          holdingId: input.holdingId,
          scopeId,
          ...(input.date === undefined ? {} : { date: input.date }),
        });
        return successEnvelope(explanation);
      });
    }),
    tool("get_snapshot_history", (raw, context) => {
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
      return runAgentView(context, async (agentView) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(agentView));
        const history = await buildSnapshotHistory(agentView, {
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
    tool("get_data_quality", (raw, context) => {
      const input = raw as {
        scopeId?: string;
        category?: string;
        severity?: string;
        limit?: number;
        cursor?: string;
      };
      return runAgentView(context, async (agentView) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(agentView));
        const page = await buildDataQuality(agentView, {
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
    tool("get_trash_summary", (raw, context) => {
      const input = raw as { scopeId?: string; limit?: number; cursor?: string };
      return runAgentView(context, async (agentView) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(agentView));
        const summary = await buildTrashSummary(agentView, {
          scopeId,
          cursor: input.cursor,
          limit: clampLimit(input.limit, 500),
        });
        return { data: summary.holdings, meta: summary.meta };
      });
    }),
    tool("get_holding_detail", (raw, context) => {
      const input = raw as { holdingId: string };
      return runAgentView(context, async (agentView) =>
        successEnvelope(await buildHoldingDetail(agentView, input.holdingId)),
      );
    }),
    tool("get_price_freshness", (raw, context) => {
      const input = raw as { holdingId: string };
      return runAgentView(context, async (agentView) =>
        successEnvelope(await buildPriceFreshness(agentView, input.holdingId)),
      );
    }),
    tool("get_operations", (raw, context) => {
      const input = raw as {
        holdingId: string;
        from?: string;
        to?: string;
        sort?: "date" | "-date";
        limit?: number;
        cursor?: string;
      };
      return runAgentView(context, async (agentView) => {
        const page = await buildHoldingOperations(agentView, {
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
    tool("list_connected_sources", (_input, context) =>
      runAgentView(context, async (agentView) =>
        successEnvelope(await buildConnectedSourcesList(agentView)),
      ),
    ),
    tool("get_source_freshness", (raw, context) => {
      const input = raw as { sourceId: string };
      return runAgentView(context, async (agentView) =>
        successEnvelope(await buildSourceFreshness(agentView, input.sourceId)),
      );
    }),
    tool("get_workspace", (_input, context) =>
      runAgentView(context, async (agentView) =>
        successEnvelope(await buildWorkspaceInfo(agentView)),
      ),
    ),
    tool("get_warning_overrides", (_input, context) =>
      runAgentView(context, async (agentView) =>
        successEnvelope(await buildWarningOverrides(agentView)),
      ),
    ),
    tool("get_connected_source_positions", async (raw, context) => {
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
      return runAgentView(context, async (agentView) => {
        const limit = clampLimit(input.limit, 500);
        if (input.holdingId !== undefined) {
          const page = await buildHoldingConnectedSourcePositions(agentView, {
            holdingId: input.holdingId,
            cursor: input.cursor,
            limit,
          });
          return { data: page.positions, meta: page.meta };
        }
        const page = await buildSourceConnectedSourcePositions(agentView, {
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

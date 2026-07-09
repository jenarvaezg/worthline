import { readDemoContext } from "@web/demo/read-demo-context";
import { withStore } from "@web/store";
import { type AgentViewReadStore, createControlPlaneStore } from "@worthline/db";
import { systemClock } from "@worthline/domain";

import {
  type AgentViewBackend,
  type AgentViewCatalogTool,
  createAgentViewCatalog,
} from "./catalog";
import {
  buildHoldingConnectedSourcePositions,
  buildSourceConnectedSourcePositions,
} from "./connected-source-positions";
import { buildConnectedSourcesList, buildSourceFreshness } from "./connected-sources";
import {
  type AgentViewDataQualityCategory,
  type AgentViewDataQualitySeverity,
  type AgentViewEnvelope,
  successEnvelope,
} from "./contract";
import { buildDataQuality } from "./data-quality";
import { buildFigureExplanation, isFigureName } from "./figure-explanations";
import { buildFinancialContext } from "./financial-context";
import { buildFireContext } from "./fire-context";
import { buildFireProjection } from "./fire-projection-context";
import { buildGoals } from "./goals-context";
import { buildHoldingDetail } from "./holding-detail";
import { buildHoldingOperations } from "./holding-operations";
import type { AgentViewMcpServerTool, AgentViewToolContext } from "./mcp-server";
import { storeTargetFromMcpAuth } from "./mcp-store-target";
import { buildPriceFreshness } from "./price-freshness";
import { listAgentViewScopes } from "./scopes";
import { buildSnapshotHistory } from "./snapshot-history";
import { STUB_NOTICE } from "./stub-catalog";
import { buildTrashSummary } from "./trash-summary";
import {
  buildMemberProfiles,
  buildWarningOverrides,
  buildWorkspaceInfo,
} from "./workspace-context";

const STUB_RESPONSE = { data: { notice: STUB_NOTICE } };

async function readBenchmarkPricesFromControlPlane(seriesId: string) {
  const url = process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
  if (!url) return [];

  const controlPlane = await createControlPlaneStore({
    url,
    ...(process.env.WORTHLINE_DB_AUTH_TOKEN
      ? { authToken: process.env.WORTHLINE_DB_AUTH_TOKEN }
      : {}),
  });
  try {
    return await controlPlane.readBenchmarkPrices(seriesId);
  } finally {
    controlPlane.close();
  }
}

/** Clamp a model-supplied page size to the service's `[1, max]` contract. */
function clampLimit(limit: number | undefined, max: number): number {
  if (limit === undefined) return 100;
  if (!Number.isFinite(limit) || limit < 1) return 100;
  return Math.min(limit, max);
}

/**
 * Wrap a paginated builder result as an envelope. The builder metas are typed
 * interfaces; the envelope's `meta` is the intentionally-loose `Record` the API
 * serializes, so the pagination meta is widened at this one seam.
 */
function pageEnvelope<T>(data: T, meta: unknown): AgentViewEnvelope<T> {
  return { data, meta: meta as Record<string, unknown> };
}

/**
 * The read-store backend: resolves every agent-view read directly against the
 * bound {@link AgentViewReadStore} (the same builders the HTTP routes call). It
 * clamps page sizes and validates the figure name in-process — the concerns the
 * HTTP routes enforce for the API adapter.
 */
function createReadStoreBackend(agentView: AgentViewReadStore): AgentViewBackend {
  return {
    listScopes: async () => successEnvelope(await listAgentViewScopes(agentView)),
    financialContext: async (scopeId, params) =>
      successEnvelope(
        await buildFinancialContext(agentView, {
          asOf: systemClock().today(),
          holdingLimit: params.holdingLimit,
          readBenchmarkPrices: readBenchmarkPricesFromControlPlane,
          scopeId,
        }),
      ),
    fireContext: async (scopeId) =>
      successEnvelope(await buildFireContext(agentView, { scopeId })),
    explainFigure: async (scopeId, params) => {
      if (!isFigureName(params.figure)) {
        // A documented 400 the read store surfaces as an error envelope, the
        // same body the HTTP route returns (chat/MCP show it as uncertainty).
        return {
          error: { code: "bad_request", message: `Unknown figure: ${params.figure}` },
        } as never;
      }
      const explanation = await buildFigureExplanation(agentView, {
        asOf: systemClock().today(),
        figure: params.figure,
        holdingId: params.holdingId,
        scopeId,
        ...(params.date === undefined ? {} : { date: params.date }),
      });
      return successEnvelope(explanation);
    },
    snapshotHistory: async (scopeId, params) => {
      const history = await buildSnapshotHistory(agentView, {
        scopeId,
        cursor: params.cursor,
        from: params.from,
        granularity: params.granularity ?? "monthly-close",
        includeHoldingRows: params.includeHoldingRows ?? "none",
        limit: clampLimit(params.limit, 500),
        sort: params.sort ?? "date",
        to: params.to,
      });
      return pageEnvelope(history.entries, history.meta);
    },
    dataQuality: async (scopeId, params) => {
      const page = await buildDataQuality(agentView, {
        scopeId,
        cursor: params.cursor,
        limit: clampLimit(params.limit, 500),
        ...(params.category === undefined
          ? {}
          : { category: params.category as AgentViewDataQualityCategory }),
        ...(params.severity === undefined
          ? {}
          : { severity: params.severity as AgentViewDataQualitySeverity }),
      });
      return pageEnvelope(page.signals, page.meta);
    },
    trashSummary: async (scopeId, params) => {
      const summary = await buildTrashSummary(agentView, {
        scopeId,
        cursor: params.cursor,
        limit: clampLimit(params.limit, 500),
      });
      return pageEnvelope(summary.holdings, summary.meta);
    },
    holdingDetail: async (holdingId) =>
      successEnvelope(
        await buildHoldingDetail(agentView, holdingId, {
          readBenchmarkPrices: readBenchmarkPricesFromControlPlane,
        }),
      ),
    priceFreshness: async (holdingId) =>
      successEnvelope(await buildPriceFreshness(agentView, holdingId)),
    operations: async (params) => {
      const page = await buildHoldingOperations(agentView, {
        holdingId: params.holdingId,
        cursor: params.cursor,
        from: params.from,
        limit: clampLimit(params.limit, 500),
        sort: params.sort ?? "-date",
        to: params.to,
      });
      return pageEnvelope(page.operations, page.meta);
    },
    holdingConnectedSourcePositions: async (params) => {
      const page = await buildHoldingConnectedSourcePositions(agentView, {
        holdingId: params.holdingId,
        cursor: params.cursor,
        limit: clampLimit(params.limit, 500),
      });
      return pageEnvelope(page.positions, page.meta);
    },
    sourceConnectedSourcePositions: async (params) => {
      const page = await buildSourceConnectedSourcePositions(agentView, {
        sourceId: params.sourceId,
        cursor: params.cursor,
        limit: clampLimit(params.limit, 500),
      });
      return pageEnvelope(page.groups, page.meta);
    },
    connectedSources: async () =>
      successEnvelope(await buildConnectedSourcesList(agentView)),
    sourceFreshness: async (sourceId) =>
      successEnvelope(await buildSourceFreshness(agentView, sourceId)),
    workspace: async () => successEnvelope(await buildWorkspaceInfo(agentView)),
    warningOverrides: async () => successEnvelope(await buildWarningOverrides(agentView)),
    memberProfiles: async () => successEnvelope(await buildMemberProfiles(agentView)),
    goals: async (scopeId) => successEnvelope(await buildGoals(agentView, scopeId)),
    fireProjection: async (scopeId) =>
      successEnvelope(await buildFireProjection(agentView, scopeId)),
  };
}

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

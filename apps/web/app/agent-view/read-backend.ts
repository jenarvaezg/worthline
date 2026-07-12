import { readBenchmarkPricesFromControlPlane } from "@web/read-benchmark-prices";
import { type AgentViewReadStore } from "@worthline/db";
import { systemClock } from "@worthline/domain";

import { type AgentViewBackend, type AgentViewCatalogTool } from "./catalog";
import {
  buildHoldingConnectedSourcePositions,
  buildSourceConnectedSourcePositions,
} from "./connected-source-positions";
import { buildConnectedSourcesList, buildSourceFreshness } from "./connected-sources";
import {
  type AgentViewDataQualityCategory,
  type AgentViewDataQualitySeverity,
  type AgentViewEnvelope,
  type AgentViewErrorEnvelope,
  successEnvelope,
} from "./contract";
import { buildContributionPlanContext } from "./contribution-plan-context";
import { buildDataQuality } from "./data-quality";
import { buildFigureExplanation, isFigureName } from "./figure-explanations";
import { buildFinancialContext } from "./financial-context";
import { buildFireContext } from "./fire-context";
import { buildFireProjection } from "./fire-projection-context";
import { buildGoals } from "./goals-context";
import { buildHoldingDetail } from "./holding-detail";
import { buildHoldingOperations } from "./holding-operations";
import { clampPositiveLimit } from "./pagination";
import { buildPriceFreshness } from "./price-freshness";
import { listAgentViewScopes } from "./scopes";
import { buildSnapshotHistory } from "./snapshot-history";
import { buildTrashSummary } from "./trash-summary";
import {
  buildMemberProfiles,
  buildWarningOverrides,
  buildWorkspaceInfo,
} from "./workspace-context";

const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;

/**
 * Wrap a paginated builder result as an envelope. The builder metas are typed
 * interfaces; the envelope's `meta` is the intentionally-loose `Record` the API
 * serializes, so the pagination meta is widened at this one seam.
 */
function pageEnvelope<T>(data: T, meta: unknown): AgentViewEnvelope<T> {
  return { data, meta: meta as Record<string, unknown> };
}

function pageLimit(limit: number | undefined): number {
  return clampPositiveLimit(limit, {
    defaultLimit: PAGE_DEFAULT,
    maxLimit: PAGE_MAX,
    onInvalid: "default",
  });
}

/**
 * The read-store backend: resolves every agent-view read directly against the
 * bound {@link AgentViewReadStore}. Page sizes and figure-name validation are
 * enforced here so HTTP, MCP, and chat adapters share one dispatch shape.
 */
export function createReadStoreBackend(
  agentView: AgentViewReadStore,
  options: { asOf?: string } = {},
): AgentViewBackend {
  const asOf = options.asOf ?? systemClock().today();

  return {
    listScopes: async () => successEnvelope(await listAgentViewScopes(agentView)),
    financialContext: async (scopeId, params) =>
      successEnvelope(
        await buildFinancialContext(agentView, {
          asOf,
          holdingLimit: params.holdingLimit,
          readBenchmarkPrices: readBenchmarkPricesFromControlPlane,
          scopeId,
        }),
      ),
    fireContext: async (scopeId) =>
      successEnvelope(await buildFireContext(agentView, { scopeId })),
    explainFigure: async (scopeId, params) => {
      if (!isFigureName(params.figure)) {
        return {
          error: { code: "bad_request", message: `Unknown figure: ${params.figure}` },
        } as never;
      }
      const explanation = await buildFigureExplanation(agentView, {
        asOf,
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
        limit: pageLimit(params.limit),
        sort: params.sort ?? "date",
        to: params.to,
      });
      return pageEnvelope(history.entries, history.meta);
    },
    dataQuality: async (scopeId, params) => {
      const page = await buildDataQuality(agentView, {
        scopeId,
        cursor: params.cursor,
        limit: pageLimit(params.limit),
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
        limit: pageLimit(params.limit),
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
        limit: pageLimit(params.limit),
        sort: params.sort ?? "-date",
        to: params.to,
      });
      return pageEnvelope(page.operations, page.meta);
    },
    holdingConnectedSourcePositions: async (params) => {
      const page = await buildHoldingConnectedSourcePositions(agentView, {
        holdingId: params.holdingId,
        cursor: params.cursor,
        limit: pageLimit(params.limit),
      });
      return pageEnvelope(page.positions, page.meta);
    },
    sourceConnectedSourcePositions: async (params) => {
      const page = await buildSourceConnectedSourcePositions(agentView, {
        sourceId: params.sourceId,
        cursor: params.cursor,
        limit: pageLimit(params.limit),
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
    contributionPlan: async (scopeId, params) =>
      successEnvelope(
        await buildContributionPlanContext(agentView, {
          scopeId,
          asOf,
          ...(params.month === undefined ? {} : { month: params.month }),
          ...(params.growthAssumption === undefined
            ? {}
            : { growthAssumption: params.growthAssumption }),
          ...(params.reconciliationWindowDays === undefined
            ? {}
            : {
                reconciliationWindowDays: clampReconciliationWindow(
                  params.reconciliationWindowDays,
                ),
              }),
        }),
      ),
  };
}

function clampReconciliationWindow(days: number): number {
  if (!Number.isFinite(days) || days < 1) {
    return 90;
  }
  return Math.min(Math.floor(days), 366);
}

/** Run one catalog tool against a read-store backend. */
export async function runCatalogRead<Input, Output>(
  tool: AgentViewCatalogTool<Input, Output>,
  input: Input,
  agentView: AgentViewReadStore,
  options: { asOf?: string } = {},
): Promise<Output> {
  return tool.run(input, createReadStoreBackend(agentView, options));
}

/** True when the catalog returned the documented error envelope instead of data. */
export function isAgentViewErrorEnvelope(
  result: unknown,
): result is AgentViewErrorEnvelope {
  return typeof result === "object" && result !== null && "error" in result;
}

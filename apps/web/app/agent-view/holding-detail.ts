import type { AgentViewReadStore } from "@worthline/db";
import {
  collectWarnings,
  defaultsFor,
  listScopeOptions,
  projectPortfolio,
} from "@worthline/domain";
import type { RowOwnership, Workspace } from "@worthline/domain";

import {
  AgentViewHttpError,
  type AgentViewHoldingDetail,
  type AgentViewHoldingSourceSummary,
  type AgentViewMoney,
  type AgentViewOwnershipShare,
} from "./contract";
import { ratioStringFromBps } from "./financial-context";
import { summarizeOperations } from "./operation-summary";
import {
  publicIdMap,
  requirePublicId,
  resolveInternalHoldingId,
} from "./scope-resolution";

/**
 * Assemble one holding's full detail from persisted state, with no side effects
 * (PRD #328, #337). Values come from the household scope projection (full,
 * unscoped value), matching the compact context's domain figures
 * (`projectPortfolio`) — never the dashboard load path, so a read cannot refresh
 * prices. Deep valuation/debt facts (amortization, anchors) are issue #338.
 */
export function buildHoldingDetail(
  store: AgentViewReadStore,
  publicHoldingId: string,
): AgentViewHoldingDetail {
  const workspace = store.readWorkspace();

  if (!workspace) {
    throw unknownHolding();
  }

  const internalHoldingId = resolveInternalHoldingId(store, publicHoldingId);
  const assets = store.readAssets();
  const liabilities = store.readLiabilities();
  const scope = householdScope(workspace);
  const projection = projectPortfolio({ assets, liabilities, scope, workspace });

  const assetRow = projection.sections[0].rows.find(
    (row) => row.id === internalHoldingId,
  );
  const liabilityRow = projection.sections[1].rows.find(
    (row) => row.id === internalHoldingId,
  );

  if (!assetRow && !liabilityRow) {
    // The holding exists in the registry but the scope does not own it.
    throw unknownHolding();
  }

  const currency = workspace.baseCurrency;
  const common = ownershipContext(store, workspace);

  if (assetRow) {
    const isInvestment = assets.some(
      (asset) => asset.id === internalHoldingId && asset.type === "investment",
    );
    const operationSummary = isInvestment
      ? summarizeOperations(store.readOperations(internalHoldingId), currency)
      : undefined;
    const sourceSummary = buildSourceSummary(store, internalHoldingId);

    return {
      currentValue: moneyOf(assetRow.valueMinor, currency),
      direction: "asset",
      id: publicHoldingId,
      instrument: assetRow.instrument,
      label: assetRow.name,
      liquidityTier: assetRow.tier,
      object: "holding",
      ownership: toOwnership(assetRow.ownership, common),
      qualitySummary: { hasWarnings: holdingHasWarnings(assets, internalHoldingId) },
      valuationMethod: defaultsFor(assetRow.instrument).valuationMethod,
      ...(operationSummary ? { operationSummary } : {}),
      ...(sourceSummary ? { sourceSummary } : {}),
    };
  }

  const row = liabilityRow!;
  return {
    currentValue: moneyOf(row.balanceMinor, currency),
    direction: "liability",
    id: publicHoldingId,
    instrument: row.instrument,
    label: row.name,
    liquidityTier: row.tier,
    object: "holding",
    ownership: toOwnership(row.ownership, common),
    qualitySummary: { hasWarnings: false },
    valuationMethod: defaultsFor(row.instrument).valuationMethod,
  };
}

function householdScope(workspace: Workspace) {
  const scope = listScopeOptions(workspace).find((option) => option.id === "household");

  if (!scope) {
    throw new AgentViewHttpError({
      code: "internal_error",
      message: "Agent view household scope is not resolvable.",
      status: 500,
    });
  }

  return scope;
}

interface OwnershipContext {
  memberPublicIds: Map<string, string>;
  memberLabels: Map<string, string>;
}

function ownershipContext(
  store: AgentViewReadStore,
  workspace: Workspace,
): OwnershipContext {
  return {
    memberLabels: new Map(workspace.members.map((member) => [member.id, member.name])),
    memberPublicIds: publicIdMap(store.readPublicIds(), "member"),
  };
}

function toOwnership(
  ownership: RowOwnership,
  context: OwnershipContext,
): AgentViewOwnershipShare[] {
  return ownership.shares
    .filter((share) => context.memberLabels.has(share.memberId))
    .map((share) => ({
      member: {
        id: requirePublicId(context.memberPublicIds, share.memberId),
        label: context.memberLabels.get(share.memberId) ?? "",
        object: "member" as const,
      },
      share: ratioStringFromBps(share.shareBps),
    }));
}

/** True when the holding carries any surfaced domain warning (issue #341 deepens this). */
function holdingHasWarnings(
  assets: ReturnType<AgentViewReadStore["readAssets"]>,
  internalHoldingId: string,
): boolean {
  return collectWarnings(assets).some(
    (warning) => warning.entityId === internalHoldingId,
  );
}

/** The connected source that materialized this holding, when one did. */
function buildSourceSummary(
  store: AgentViewReadStore,
  internalHoldingId: string,
): AgentViewHoldingSourceSummary | undefined {
  const source = store
    .readConnectedSources()
    .find((candidate) => candidate.assetIds.includes(internalHoldingId));

  if (!source) {
    return undefined;
  }

  return { adapter: source.adapter, label: source.label, lastSyncAt: source.lastSyncAt };
}

function moneyOf(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}

function unknownHolding(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown holding.",
    status: 404,
  });
}

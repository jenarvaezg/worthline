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
import {
  assetHoldingFacts,
  liabilityHoldingFacts,
  type HoldingFacts,
} from "./holding-facts";
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
export async function buildHoldingDetail(
  store: AgentViewReadStore,
  publicHoldingId: string,
): Promise<AgentViewHoldingDetail> {
  const workspace = await store.readWorkspace();

  if (!workspace) {
    throw unknownHolding();
  }

  const internalHoldingId = await resolveInternalHoldingId(store, publicHoldingId);
  const assets = await store.readAssets();
  const liabilities = await store.readLiabilities();
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
  const common = await ownershipContext(store, workspace);

  if (assetRow) {
    const isInvestment = assets.some(
      (asset) => asset.id === internalHoldingId && asset.type === "investment",
    );
    const operationSummary = isInvestment
      ? summarizeOperations(await store.readOperations(internalHoldingId), currency)
      : undefined;
    const sourceSummary = await buildSourceSummary(store, internalHoldingId);
    const valuationMethod = defaultsFor(assetRow.instrument).valuationMethod;
    const facts = await assetHoldingFacts(
      store,
      internalHoldingId,
      valuationMethod,
      currency,
    );

    return {
      currentValue: moneyOf(assetRow.valueMinor, currency),
      direction: "asset",
      id: publicHoldingId,
      instrument: assetRow.instrument,
      label: assetRow.name,
      liquidityTier: assetRow.tier,
      object: "holding",
      ownership: toOwnership(assetRow.ownership, common),
      qualitySummary: qualitySummary(
        holdingHasWarnings(assets, internalHoldingId),
        facts,
      ),
      valuationMethod,
      ...(operationSummary ? { operationSummary } : {}),
      ...(sourceSummary ? { sourceSummary } : {}),
      ...factBlocks(facts),
    };
  }

  const row = liabilityRow!;
  const valuationMethod = defaultsFor(row.instrument).valuationMethod;
  const facts = await liabilityHoldingFacts(
    store,
    internalHoldingId,
    valuationMethod,
    currency,
  );
  return {
    currentValue: moneyOf(row.balanceMinor, currency),
    direction: "liability",
    id: publicHoldingId,
    instrument: row.instrument,
    label: row.name,
    liquidityTier: row.tier,
    object: "holding",
    ownership: toOwnership(row.ownership, common),
    qualitySummary: qualitySummary(false, facts),
    valuationMethod,
    ...factBlocks(facts),
  };
}

/** Fold the holding's fact blocks into the detail, omitting any that are absent. */
function factBlocks(facts: HoldingFacts) {
  return {
    ...(facts.valuationAnchors ? { valuationAnchors: facts.valuationAnchors } : {}),
    ...(facts.amortization ? { amortization: facts.amortization } : {}),
    ...(facts.balanceAnchors ? { balanceAnchors: facts.balanceAnchors } : {}),
  };
}

/**
 * The holding's quality summary: the #341 warnings boolean plus the #338
 * calculation-fact state, surfaced only when the holding cannot honestly
 * produce its method's facts (never `unsupported` is treated as a defect — it is
 * a documented "no dated facts here" marker, so it rides the same field).
 */
function qualitySummary(hasWarnings: boolean, facts: HoldingFacts) {
  return {
    hasWarnings,
    ...(facts.state ? { facts: facts.state } : {}),
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

async function ownershipContext(
  store: AgentViewReadStore,
  workspace: Workspace,
): Promise<OwnershipContext> {
  return {
    memberLabels: new Map(workspace.members.map((member) => [member.id, member.name])),
    memberPublicIds: publicIdMap(await store.readPublicIds(), "member"),
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
  assets: Awaited<ReturnType<AgentViewReadStore["readAssets"]>>,
  internalHoldingId: string,
): boolean {
  return collectWarnings(assets).some(
    (warning) => warning.entityId === internalHoldingId,
  );
}

/** The connected source that materialized this holding, when one did. */
async function buildSourceSummary(
  store: AgentViewReadStore,
  internalHoldingId: string,
): Promise<AgentViewHoldingSourceSummary | undefined> {
  const source = (await store.readConnectedSources()).find((candidate) =>
    candidate.assetIds.includes(internalHoldingId),
  );

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

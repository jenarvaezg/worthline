import { buildHoldingBenchmarkComparison } from "@web/build-holding-benchmark";
import { readExposureCatalogFromControlPlane } from "@web/read-exposure-catalog";
import type { AgentViewReadStore } from "@worthline/db";
import type {
  ExposureProfile,
  Instrument,
  RowOwnership,
  Workspace,
} from "@worthline/domain";
import {
  collectWarnings,
  defaultsFor,
  listScopeOptions,
  monthlyCloseValuesFromSnapshotRows,
  projectPortfolio,
  systemClock,
} from "@worthline/domain";
import {
  type AgentViewExposureProfile,
  type AgentViewHoldingDetail,
  type AgentViewHoldingSourceSummary,
  AgentViewHttpError,
  type AgentViewMoney,
  type AgentViewOwnershipShare,
  type AgentViewVsBenchmark,
} from "./contract";
import {
  type ReadExposureCatalog,
  type ResolvedExposureCatalog,
  resolveExposureCatalog,
} from "./exposure-catalog";
import type { AgentViewBenchmarkPrice } from "./financial-context";
import { ratioStringFromBps } from "./financial-context";
import {
  assetHoldingFacts,
  type HoldingFacts,
  liabilityHoldingFacts,
} from "./holding-facts";
import { summarizeOperations } from "./operation-summary";
import { buildHoldingPayouts } from "./payouts";
import { buildHoldingReturns } from "./returns";
import {
  publicIdMap,
  requirePublicId,
  resolveInternalHoldingId,
} from "./scope-resolution";

export interface BuildHoldingDetailOptions {
  readBenchmarkPrices?: (seriesId: string) => Promise<AgentViewBenchmarkPrice[]>;
  /** Global exposure-profile catalog reader (PRD #711 S3); defaults to the control plane. */
  readExposureCatalog?: ReadExposureCatalog;
}

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
  options: BuildHoldingDetailOptions = {},
): Promise<AgentViewHoldingDetail> {
  const workspace = await store.readWorkspace();

  if (!workspace) {
    throw unknownHolding();
  }

  const internalHoldingId = await resolveInternalHoldingId(store, publicHoldingId);
  // Curve-valued today so `currentValue` matches the dashboard's live figure —
  // the deep facts below (plan, anchors, repayments) still echo the stored record.
  const valuationDate = systemClock().today();
  const { assets, liabilities } = await store.readCurveValuedHoldings(valuationDate);
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
    const operations = isInvestment ? await store.readOperations(internalHoldingId) : [];
    const operationSummary = isInvestment
      ? summarizeOperations(operations, currency)
      : undefined;
    const sourceSummary = await buildSourceSummary(store, internalHoldingId);
    const valuationMethod = defaultsFor(assetRow.instrument).valuationMethod;
    const facts = await assetHoldingFacts(
      store,
      internalHoldingId,
      valuationMethod,
      currency,
    );
    const catalog = resolveExposureCatalog(
      await (options.readExposureCatalog ?? readExposureCatalogFromControlPlane)(),
    );
    const exposure = await resolveExposureProfile(
      store,
      catalog,
      internalHoldingId,
      assetRow.instrument,
    );
    const investmentMeta = (await store.readInvestmentAssetsWithMeta()).find(
      (row) => row.id === internalHoldingId,
    );

    return {
      currentValue: moneyOf(assetRow.valueMinor, currency),
      direction: "asset",
      exposureProfile: exposure.profile,
      ...(exposure.status ? { exposureProfileStatus: exposure.status } : {}),
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
      payouts: await buildHoldingPayouts({
        assetId: internalHoldingId,
        currency,
        store,
        todayISO: valuationDate,
      }),
      returns: await buildHoldingReturns({
        assetId: internalHoldingId,
        currency,
        currentValueMinor: assetRow.valueMinor,
        instrument: assetRow.instrument,
        operations,
        snapshotScopeId: "household",
        store,
        valuationDate,
      }),
      valuationMethod,
      vsBenchmark: await buildVsBenchmark({
        assetId: internalHoldingId,
        catalogUnavailable: exposure.status === "catalog_unavailable",
        distributing: investmentMeta?.benchmarkDistributing ?? false,
        operations,
        readBenchmarkPrices: options.readBenchmarkPrices,
        store,
        trackedIndex: exposure.profile?.trackedIndex,
      }),
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
    vsBenchmark: unavailableVsBenchmark("no_tracked_index"),
    ...factBlocks(facts),
  };
}

async function buildVsBenchmark(input: {
  assetId: string;
  catalogUnavailable: boolean;
  distributing: boolean;
  operations: Awaited<ReturnType<AgentViewReadStore["readOperations"]>>;
  readBenchmarkPrices: BuildHoldingDetailOptions["readBenchmarkPrices"];
  store: AgentViewReadStore;
  trackedIndex: string | null | undefined;
}): Promise<AgentViewVsBenchmark> {
  // The tracked index lives in the exposure catalog, so a catalog we could not
  // read is reported honestly as `catalog_unavailable` — never mislabelled
  // `no_tracked_index`, which would imply the security genuinely tracks nothing.
  if (input.catalogUnavailable) {
    return unavailableVsBenchmark("catalog_unavailable");
  }

  const monthlyCloses = monthlyCloseValuesFromSnapshotRows(
    await input.store.readSnapshotHoldings({
      holdingId: input.assetId,
      kind: "asset",
      scopeId: "household",
    }),
  );
  const result = await buildHoldingBenchmarkComparison({
    distributing: input.distributing,
    monthlyCloses,
    operations: input.operations,
    trackedIndex: input.trackedIndex,
    ...(input.readBenchmarkPrices
      ? { readBenchmarkPrices: input.readBenchmarkPrices }
      : {}),
  });
  return toAgentViewVsBenchmark(result);
}

function toAgentViewVsBenchmark(
  result: Awaited<ReturnType<typeof buildHoldingBenchmarkComparison>>,
): AgentViewVsBenchmark {
  if (!result.comparison) {
    return {
      comparison: null,
      unavailableReason: result.unavailableReason,
    };
  }

  return {
    comparison: {
      coverageNote: result.comparison.coverageNote,
      excessGrowth: result.comparison.realGrowth,
      holdingTwr: result.comparison.subjectGrowth,
      indexGrowth: result.comparison.benchmarkGrowth,
      seriesId: result.comparison.seriesId,
      sinceDate: result.comparison.sinceDate,
      trackedIndex: result.comparison.trackedIndex,
      untilDate: result.comparison.untilDate,
      variant: result.comparison.variant,
    },
    unavailableReason: null,
  };
}

function unavailableVsBenchmark(
  reason: NonNullable<AgentViewVsBenchmark["unavailableReason"]>,
): AgentViewVsBenchmark {
  return { comparison: null, unavailableReason: reason };
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

const EXPOSURE_PROFILE_INSTRUMENTS = new Set<Instrument>([
  "fund",
  "etf",
  "stock",
  "index",
  "pension_plan",
]);

/** A holding's exposure profile plus WHY it is absent, when it is (#711 S3). */
interface ExposureProfileResolution {
  profile: AgentViewExposureProfile | null;
  /**
   * Set only when the holding has a KNOWN identity but no profile object:
   * `profile_missing` (the catalog has no row) vs `catalog_unavailable` (the
   * catalog itself could not be read). Absent when a profile is present, or when
   * the instrument takes no profile / the holding has no identity.
   */
  status?: "profile_missing" | "catalog_unavailable";
}

/**
 * Resolve a holding's exposure profile from the global catalog (PRD #711 S3, ADR
 * 0058). Only instruments with an underlying portfolio carry one; the key is the
 * security identity `isin ?? providerSymbol`. Returns a `null` profile — never
 * fabricated — when the instrument takes none or has no identity (no `status`),
 * when the catalog has no row for a known identity (`profile_missing`), or when
 * the catalog could not be read for a known identity (`catalog_unavailable`).
 */
async function resolveExposureProfile(
  store: AgentViewReadStore,
  catalog: ResolvedExposureCatalog,
  internalHoldingId: string,
  instrument: Instrument,
): Promise<ExposureProfileResolution> {
  if (!EXPOSURE_PROFILE_INSTRUMENTS.has(instrument)) {
    return { profile: null };
  }

  const meta = (await store.readInvestmentAssetsWithMeta()).find(
    (row) => row.id === internalHoldingId,
  );
  const key = meta?.isin ?? meta?.providerSymbol ?? null;
  if (!key) {
    return { profile: null };
  }

  if (catalog.status === "unavailable") {
    return { profile: null, status: "catalog_unavailable" };
  }

  const profile = catalog.profiles.get(key) ?? null;
  return profile
    ? { profile: toExposureProfile(profile) }
    : { profile: null, status: "profile_missing" };
}

/** Map the domain profile to the contract shape (nullable scalars, string breakdowns). */
function toExposureProfile(profile: ExposureProfile): AgentViewExposureProfile {
  return {
    breakdowns: {
      ...(profile.breakdowns.geography
        ? { geography: profile.breakdowns.geography }
        : {}),
      ...(profile.breakdowns.currency ? { currency: profile.breakdowns.currency } : {}),
      ...(profile.breakdowns.assetClass
        ? { assetClass: profile.breakdowns.assetClass }
        : {}),
      ...(profile.breakdowns.sector ? { sector: profile.breakdowns.sector } : {}),
    },
    hedged: profile.hedged ?? false,
    ter: profile.ter ?? null,
    trackedIndex: profile.trackedIndex ?? null,
  };
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

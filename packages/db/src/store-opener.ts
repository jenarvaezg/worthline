import type { Client } from "@libsql/client";
import type { FireScopeConfig } from "@worthline/domain";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { createAgentViewReadStore } from "./agent-view-read-store";
import { createAssetStore } from "./asset-store";
import { createAssistantProposalStore } from "./assistant-proposal-store";
import {
  applyPostMigrateReripples,
  createDatedFactCommandImplementations,
} from "./commands/dated-facts";
import { createCommandHost } from "./commands/host";
import { createConnectedSourceSeams } from "./connected-source-seams";
import { createConnectedSourceStore } from "./connected-source-store";
import { createContributionPlanStore } from "./contribution-plan-store";
import {
  migrateTarget,
  openDatabaseTarget,
  resolveDatabaseTarget,
} from "./database-target";
import { createGoalStore } from "./goal-store";
import { createLiabilityStore } from "./liability-store";
import { openLibsqlClient } from "./libsql-client";
import { type MigrateResult, migrate } from "./migrate";
import { createOperationsStore } from "./operations-store";
import { createPayoutStore } from "./payout-store";
import { appSettings, assets, auditLog, liabilities, warningOverrides } from "./schema";
import {
  createSnapshotOrchestrator,
  gapFillHistoricalSnapshots,
} from "./snapshot-orchestrator";
import { createSnapshotStore } from "./snapshot-store";
import {
  createStoreContext,
  hardDeleteAssetTx,
  hardDeleteLiabilityTx,
  type StoreContext,
} from "./store-context";
import type {
  BatchTrashResult,
  HoldingTrashTarget,
  WorthlineStore,
  WorthlineStoreOptions,
} from "./store-types";
import { createSyncRunStore } from "./sync-run-store";
import { createWorkspaceStore, readWorkspace } from "./workspace-store";

/**
 * Create a throwaway WorthlineStore backed by an in-memory SQLite database.
 * The full schema and forward-migration ladder (ADR-0002) are applied on
 * construction, so the store is immediately usable for testing.
 *
 * Each call produces an independent, isolated database — parallel tests are
 * safe and no files are left behind.  Callers must call store.close() when done.
 */
export async function createInMemoryStore(): Promise<WorthlineStore> {
  const client = openLibsqlClient(":memory:");
  const migrateResult = await migrate(client);
  return buildStore(client, migrateResult);
}

/**
 * Open an existing SQLite connection as a WorthlineStore, running the migration
 * ladder (and any post-migrate re-ripples) on it. Useful in tests that seed a
 * legacy-schema database and then need to verify the store behaves correctly
 * after migration — without going through the file-path lifecycle of
 * `createWorthlineStoreUnsafe`.
 */
export async function createStoreFromSqlite(client: Client): Promise<WorthlineStore> {
  const migrateResult = await migrate(client);
  return buildStore(client, migrateResult);
}

/**
 * Sentinel thrown to unwind {@link runBatchTrash}'s transaction when one target
 * fails, so the whole baja/restauración batch rolls back atomically. Caught at
 * the seam boundary and turned into a `{ ok: false }` result — never leaks.
 */
class BatchTrashAbort extends Error {
  constructor(
    readonly holdingId: string,
    readonly reason: "not_found" | "not_in_trash",
  ) {
    super("batch trash aborted");
    this.name = "BatchTrashAbort";
  }
}

/**
 * Apply a per-holding trash mutation across N targets inside ONE transaction
 * (PRD #1103 S3, #1106). Mirrors {@link emptyTrash}: it composes the existing
 * soft-delete / restore seams so a mid-batch failure (a seam returning 0 rows)
 * throws the sentinel, rolls the whole unit back, and surfaces as a typed
 * `{ ok: false }` — nothing half-applies.
 */
async function runBatchTrash(
  ctx: StoreContext,
  targets: readonly HoldingTrashTarget[],
  reason: "not_found" | "not_in_trash",
  apply: (target: HoldingTrashTarget) => Promise<number>,
): Promise<BatchTrashResult> {
  try {
    const count = await ctx.transaction(async () => {
      let touched = 0;
      for (const target of targets) {
        const affected = await apply(target);
        if (affected === 0) throw new BatchTrashAbort(target.holdingId, reason);
        touched += affected;
      }
      return touched;
    });
    return { count, ok: true };
  } catch (error) {
    if (error instanceof BatchTrashAbort) {
      return { holdingId: error.holdingId, ok: false, reason: error.reason };
    }
    throw error;
  }
}

/**
 * The RAW workspace-store opener. It resolves whatever database the options (or
 * env) point at — an authenticated workspace URL, or the local file path when
 * unspecified — with NO authorization. The `Unsafe` suffix is deliberate: a
 * request surface (RSC/REST/MCP) must never import this by accident, because it
 * ignores the caller's principal entirely (PRD #998 S1, decision #892).
 *
 * It is deliberately kept OFF the package's public `@worthline/db` barrel (#1123):
 * it is reachable only through the internal `@worthline/db/unsafe-store` subpath,
 * whose one authorized request-side importer is the web authorization port
 * (`apps/web/app/principal.ts`, `withAuthorizedStore`). Non-request callers that
 * legitimately bring their own coordinates — cron, scripts, migrations, tests —
 * import the subpath directly.
 */
export async function createWorthlineStoreUnsafe(
  options: WorthlineStoreOptions = {},
): Promise<WorthlineStore> {
  const target = resolveDatabaseTarget(options);
  const client = openDatabaseTarget(target);
  const migrateResult = await migrateTarget(target, client);
  return buildStore(client, migrateResult);
}

async function buildStore(
  client: Client,
  migrateResult: MigrateResult,
): Promise<WorthlineStore> {
  // Shared substrate for the extracted *-Store slices (R1–R5, PRD #120): the
  // connection, id generation, transaction wrapping, audit logging, and the
  // per-unit-of-work workspace cache all live in one place.
  const ctx = createStoreContext(client, readWorkspace);
  const { writeAuditEntry } = ctx;
  const snapshotStore = createSnapshotStore(ctx);
  const assetStore = createAssetStore(ctx);
  const liabilityStore = createLiabilityStore(ctx);
  const operationsStore = createOperationsStore(ctx);
  const connectedSourceStore = createConnectedSourceStore(ctx);
  const syncRunStore = createSyncRunStore(ctx);
  const goalStore = createGoalStore(ctx);
  const payoutStore = createPayoutStore(ctx);
  const contributionPlanStore = createContributionPlanStore(ctx);
  const assistantProposalStore = createAssistantProposalStore(ctx);
  const agentViewReadStore = createAgentViewReadStore(ctx, {
    listConnectedSources: connectedSourceStore.listSources,
    listSourceAssetIds: connectedSourceStore.listSourceAssetIds,
    readAmortizationPlan: liabilityStore.readAmortizationPlan,
    readAssets: assetStore.readAssets,
    readCurveValuedHoldings: (dateKey) =>
      snapshotStore.readCurveValuedHoldingsAtDate(dateKey),
    readGoals: goalStore.readGoals,
    readBalanceAnchors: liabilityStore.readBalanceAnchors,
    readBalanceRebaselines: liabilityStore.readBalanceRebaselines,
    readDebtModel: liabilityStore.readDebtModel,
    readEarlyRepayments: liabilityStore.readEarlyRepayments,
    readFireConfig: () => store.readFireConfig(),
    readInterestRateRevisions: liabilityStore.readInterestRateRevisions,
    readInvestmentAssetsWithMeta: assetStore.readInvestmentAssetsWithMeta,
    readLiabilities: liabilityStore.readLiabilities,
    readOperations: operationsStore.readOperations,
    readPriceCache: async (assetId) => {
      const cache = await operationsStore.readPriceCache(assetId);
      if (!cache) {
        return null;
      }
      return {
        fetchedAt: cache.fetchedAt,
        freshnessState: cache.freshnessState,
        source: cache.source,
        ...(cache.staleReason === undefined ? {} : { staleReason: cache.staleReason }),
      };
    },
    readPayouts: payoutStore.readPayouts,
    readPayoutsForHolding: payoutStore.readPayoutsForHolding,
    readPayoutSchedules: payoutStore.readPayoutSchedules,
    readPayoutSchedulesForHolding: payoutStore.readPayoutSchedulesForHolding,
    readContributionPlan: contributionPlanStore.readContributionPlan,
    readContributionReconciliations: contributionPlanStore.readReconciliations,
    readAllPriceCacheEntries: () => operationsStore.readAllPriceCacheEntries(),
    readSnapshotHoldings: snapshotStore.readSnapshotHoldings,
    readSnapshots: (scopeId) => snapshotStore.readSnapshots(scopeId),
    readSourcePositions: connectedSourceStore.readPositions,
    readSourcePriceCache: async (assetId) => {
      const cache = await operationsStore.readPriceCache(assetId);
      if (!cache) {
        return null;
      }
      return {
        fetchedAt: cache.fetchedAt,
        freshnessState: cache.freshnessState,
        ...(cache.staleReason === undefined ? {} : { staleReason: cache.staleReason }),
      };
    },
    readValuationAnchors: assetStore.readValuationAnchors,
    readWarningOverrides: () => store.readWarningOverrides(),
  });
  // importWorkspace's post-import gap-fill spans every domain and the snapshot
  // save path, so it stays in the monolith and is injected into the workspace
  // store as a dependency. The arrow defers reading store.snapshots.saveSnapshot until
  // call-time, by which point store is fully constructed (same forward-
  // reference pattern as rippleHistoricalSnapshotsForOperation).
  const workspaceStore = createWorkspaceStore(ctx, {
    gapFillHistoricalSnapshots: (workspace, today) =>
      gapFillHistoricalSnapshots(ctx, workspace, store.snapshots.saveSnapshot, today),
  });

  const datedFactCommands = createDatedFactCommandImplementations(ctx, {
    assets: assetStore,
    liabilities: liabilityStore,
    snapshots: snapshotStore,
    operations: operationsStore,
    contributionPlan: contributionPlanStore,
  });
  const connectedSourceSeams = createConnectedSourceSeams(ctx, {
    connectedSources: connectedSourceStore,
    snapshots: snapshotStore,
    syncRuns: syncRunStore,
  });
  const snapshotOrchestrator = createSnapshotOrchestrator(ctx, {
    snapshots: snapshotStore,
  });

  const commandHost = createCommandHost(
    ctx,
    { saveSnapshot: snapshotStore.saveSnapshot },
    {
      assistantProposals: assistantProposalStore,
      connectedSources: connectedSourceSeams,
      datedFacts: datedFactCommands,
      factPersistence: { addBalanceRebaseline: liabilityStore.addBalanceRebaseline },
      liabilityReads: { debtBalanceAtDate: liabilityStore.debtBalanceAtDate },
      snapshotOrchestrator,
    },
  );

  const store: WorthlineStore = {
    snapshots: snapshotStore,
    assets: assetStore,
    liabilities: liabilityStore,
    operations: operationsStore,
    workspace: workspaceStore,
    connectedSources: connectedSourceStore,
    goals: goalStore,
    payouts: payoutStore,
    contributionPlan: contributionPlanStore,
    agentView: agentViewReadStore,
    assistantProposals: assistantProposalStore,
    command: commandHost,
    close: () => {
      client.close();
    },
    readFireConfig: async () => {
      const { db } = ctx;
      const row = await db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, "fire.config"))
        .get();

      if (!row) {
        return {};
      }

      return JSON.parse(row.value) as Record<string, FireScopeConfig>;
    },
    saveFireConfig: async (scopeId, config) => {
      const { db } = ctx;
      const existing = await db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, "fire.config"))
        .get();

      const current: Record<string, FireScopeConfig> = existing
        ? (JSON.parse(existing.value) as Record<string, FireScopeConfig>)
        : {};
      const merged = { ...current, [scopeId]: config };
      const updatedAt = new Date().toISOString();

      await db
        .insert(appSettings)
        .values({ key: "fire.config", updatedAt, value: JSON.stringify(merged) })
        .onConflictDoUpdate({
          set: { updatedAt, value: JSON.stringify(merged) },
          target: appSettings.key,
        })
        .run();
    },
    acknowledgeWarning: async (code, entityId) => {
      const result = await ctx.db
        .insert(warningOverrides)
        .values({ code, entityId })
        .onConflictDoNothing({
          target: [warningOverrides.code, warningOverrides.entityId],
        })
        .run();
      if (result.rowsAffected > 0) {
        await writeAuditEntry("acknowledge_warning", "asset", entityId, { code });
      }
      return result.rowsAffected;
    },
    removeWarningOverride: async (code, entityId) => {
      await ctx.db
        .delete(warningOverrides)
        .where(
          and(eq(warningOverrides.code, code), eq(warningOverrides.entityId, entityId)),
        )
        .run();
      await writeAuditEntry("unacknowledge_warning", "asset", entityId, { code });
    },
    readWarningOverrides: () =>
      ctx.db
        .select({ code: warningOverrides.code, entityId: warningOverrides.entityId })
        .from(warningOverrides)
        .all(),
    readTrash: async () => ({
      assets: await ctx.db
        .select({ id: assets.id, name: assets.name })
        .from(assets)
        .where(isNotNull(assets.deletedAt))
        .orderBy(asc(assets.name))
        .all(),
      liabilities: await ctx.db
        .select({ id: liabilities.id, name: liabilities.name })
        .from(liabilities)
        .where(isNotNull(liabilities.deletedAt))
        .orderBy(asc(liabilities.name))
        .all(),
    }),
    emptyTrash: () =>
      ctx.transaction(async () => {
        const trashedAssets = await ctx.db
          .select({ id: assets.id })
          .from(assets)
          .where(isNotNull(assets.deletedAt))
          .all();
        const trashedLiabilities = await ctx.db
          .select({ id: liabilities.id })
          .from(liabilities)
          .where(isNotNull(liabilities.deletedAt))
          .all();

        let assetsRemoved = 0;
        let liabilitiesRemoved = 0;
        for (const row of trashedAssets)
          assetsRemoved += await hardDeleteAssetTx(ctx, row.id);
        for (const row of trashedLiabilities)
          liabilitiesRemoved += await hardDeleteLiabilityTx(ctx, row.id);

        return { assets: assetsRemoved, liabilities: liabilitiesRemoved };
      }),
    batchSoftDeleteHoldings: (targets, deletedAt) =>
      runBatchTrash(ctx, targets, "not_found", (target) =>
        target.kind === "asset"
          ? assetStore.softDeleteAsset(target.holdingId, deletedAt)
          : liabilityStore.softDeleteLiability(target.holdingId, deletedAt),
      ),
    batchRestoreHoldings: (targets) =>
      runBatchTrash(ctx, targets, "not_in_trash", (target) =>
        target.kind === "asset"
          ? assetStore.restoreAsset(target.holdingId)
          : liabilityStore.restoreLiability(target.holdingId),
      ),
    readAuditLog: async (filter) => {
      const { db } = ctx;
      const rows = filter?.entityId
        ? await db
            .select()
            .from(auditLog)
            .where(eq(auditLog.entityId, filter.entityId))
            .orderBy(asc(auditLog.createdAt))
            .all()
        : await db.select().from(auditLog).orderBy(asc(auditLog.createdAt)).all();

      return rows.map((row) => ({
        action: row.action,
        createdAt: row.createdAt,
        details: JSON.parse(row.detailsJson) as Record<string, unknown>,
        entityId: row.entityId,
        entityType: row.entityType,
        id: row.id,
      }));
    },
  };

  // Post-migrate snapshot reconstruction (issue #491): the v18 / v33 backfills
  // re-ripple frozen historical snapshots at migration time. The logic lives
  // behind the dated-fact seam module; the factory only invokes it.
  await applyPostMigrateReripples(ctx, migrateResult, {
    assets: assetStore,
    liabilities: liabilityStore,
    snapshots: snapshotStore,
  });

  return store;
}

/**
 * Run a unit of work against a freshly opened store and guarantee the SQLite
 * connection is closed afterwards — even if the callback throws. This is the one
 * home for the open/use/close lifecycle so callers never leak a connection.
 *
 * `Unsafe` for the same reason as {@link createWorthlineStoreUnsafe}: it opens
 * without a principal, and lives off the public barrel (#1123). Surfaces go
 * through the web authorization port.
 */
export async function withStoreUnsafe<T>(
  run: (store: WorthlineStore) => T | Promise<T>,
  options: WorthlineStoreOptions = {},
): Promise<T> {
  const store = await createWorthlineStoreUnsafe(options);

  try {
    return await run(store);
  } finally {
    store.close();
  }
}

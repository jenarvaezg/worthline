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
import {
  migrateTarget,
  openDatabaseTarget,
  resolveDatabaseTarget,
} from "./database-target";
import { openLibsqlClient } from "./libsql-client";
import { type MigrateResult, migrate } from "./migrate";
import { appSettings, assets, auditLog, liabilities, warningOverrides } from "./schema";
import {
  createSnapshotOrchestrator,
  gapFillHistoricalSnapshots,
} from "./snapshot-orchestrator";

export type { SharedSnapshotInputs } from "./capture-daily-snapshot";
export {
  buildSharedSnapshotInputs,
  buildTodaySnapshotForScope,
  captureDailySnapshotForWorkspace,
} from "./capture-daily-snapshot";
export type {
  AddEarlyRepaymentCommand,
  AddInterestRateRevisionCommand,
  AddValuationAnchorCommand,
  ChangeDebtModelCommand,
  CommandExecutor,
  CommandHost,
  CommandResult,
  CreateAmortizationPlanCommand,
  CreateCurrentStateDebtCommand,
  DeleteAmortizationPlanCommand,
  DeleteEarlyRepaymentCommand,
  DeleteInterestRateRevisionCommand,
  DeleteInvestmentOperationCommand,
  DeleteInvestmentOperationResult,
  DeleteValuationAnchorCommand,
  ImportBalanceHistoryCommand,
  ImportBalanceHistoryResult,
  MergeStatementOperationsCommand,
  OwnershipSplitCommandResult,
  OwnershipSplitViolation,
  RecalibrateDebtBalanceCommand,
  RecordHousingValuationCommand,
  RecordInvestmentOperationCommand,
  RipplePlan,
  SetAnnualAppreciationRateCommand,
  SetHousingValuationCadenceCommand,
  UpdateAmortizationPlanCommand,
  UpdateAssetOwnershipSplitCommand,
  UpdateEarlyRepaymentCommand,
  UpdateInterestRateRevisionCommand,
  UpdateLiabilityOwnershipSplitCommand,
  UpdateValuationAnchorCommand,
} from "./commands";
export {
  executeAddEarlyRepaymentCommand,
  executeAddInterestRateRevisionCommand,
  executeAddValuationAnchorCommand,
  executeChangeDebtModelCommand,
  executeCreateAmortizationPlanCommand,
  executeCreateCurrentStateDebtCommand,
  executeDeleteAmortizationPlanCommand,
  executeDeleteEarlyRepaymentCommand,
  executeDeleteInterestRateRevisionCommand,
  executeDeleteInvestmentOperationCommand,
  executeDeleteValuationAnchorCommand,
  executeMergeStatementOperationsCommand,
  executeRecalibrateDebtBalanceCommand,
  executeRecordHousingValuationCommand,
  executeRecordInvestmentOperationCommand,
  executeSetAnnualAppreciationRateCommand,
  executeSetHousingValuationCadenceCommand,
  executeUpdateAmortizationPlanCommand,
  executeUpdateAssetOwnershipSplitCommand,
  executeUpdateEarlyRepaymentCommand,
  executeUpdateInterestRateRevisionCommand,
  executeUpdateLiabilityOwnershipSplitCommand,
  executeUpdateValuationAnchorCommand,
  runCommand,
} from "./commands";
export {
  type BenchmarkPrice,
  type ControlPlaneGrant,
  type ControlPlaneStore,
  type ControlPlaneStoreOptions,
  type ControlPlaneUser,
  type ControlPlaneWorkspace,
  type ControlPlaneWorkspaceWithOwner,
  createControlPlaneStore,
  createInMemoryControlPlaneStore,
  type MaintainerAlert,
  type MaintainerAlertCategory,
  type MaintainerAlertOccurrence,
  type MaintainerAlertStatus,
  type MaintainerAlertWithOccurrences,
  type ProviderCooldown,
  type RaisedMaintainerAlert,
  type RaiseMaintainerAlertInput,
  type UpdateMaintainerAlertStatusInput,
} from "./control-plane";
export {
  ENCRYPTION_KEY_ENV,
  makeSecretCrypto,
  openSecret,
  type SecretCrypto,
  sealSecret,
} from "./crypto";
export {
  resolveDatabasePath,
  resolveDatabaseTarget,
  resolveDataDir,
  runBootstrapHealthcheck,
} from "./database-target";
export { openLibsqlClient } from "./libsql-client";
export { SCHEMA_VERSION } from "./migrate";
export {
  type ProvisionDeps,
  provisionWorkspaceForUser,
  type TursoPort,
} from "./provisioner";
export type {
  DailyCaptureBenchmarkFailure,
  DailyCaptureBenchmarkPrice,
  DailyCaptureBenchmarkSeries,
  DailyCaptureFailure,
  DailyCaptureFetchedPrice,
  DailyCapturePricePair,
  DailyCaptureWorkspace,
  RunDailyCaptureDeps,
  RunDailyCaptureResult,
} from "./run-daily-capture";
export { runDailyCapture } from "./run-daily-capture";
export type {
  ApplyStatementImportParams,
  AuditLogEntry,
  BootstrapHealthcheckOptions,
  CreateHousingHoldingCommand,
  DatabaseTarget,
  TrashView,
  WorthlineStore,
  WorthlineStoreOptions,
} from "./store-types";
export {
  fingerprintExport,
  type PullResult,
  type PushResult,
  type SyncDeps,
  SyncStaleError,
  syncPull,
  syncPush,
} from "./sync-engine";

import { createContributionPlanStore } from "./contribution-plan-store";
import { createExposureProfileStore } from "./exposure-profile-store";
import { createGoalStore } from "./goal-store";
import { createLiabilityStore } from "./liability-store";
import { createOperationsStore } from "./operations-store";
import { createPayoutStore } from "./payout-store";
import { createSnapshotStore } from "./snapshot-store";
import {
  createStoreContext,
  hardDeleteAssetTx,
  hardDeleteLiabilityTx,
} from "./store-context";
import type { WorthlineStore, WorthlineStoreOptions } from "./store-types";
import { createWorkspaceStore, readWorkspace } from "./workspace-store";

export type {
  AgentViewConnectedSource,
  AgentViewPriceFreshness,
  AgentViewReadStore,
  AgentViewSourceFreshness,
  AgentViewTrashedHolding,
} from "./agent-view-read-store";
export type {
  AddValuationAnchorInput,
  AssetStore,
  CreateInvestmentAssetInput,
  InvestmentAssetFull,
  InvestmentAssetMeta,
  UpdateAssetInput,
  UpdateInvestmentAssetInput,
  UpdateValuationAnchorInput,
  ValuationAnchorRecord,
} from "./asset-store";
export type {
  AppendAssistantProposalDocumentInput,
  AssistantProposal,
  AssistantProposalDocument,
  AssistantProposalDocumentRef,
  AssistantProposalFact,
  AssistantProposalStore,
  HoldingCorrectionFact,
  PropertyValuationAnchorFact,
  StatementOperationFact,
} from "./assistant-proposal-store";
export type {
  ConnectedSourceRow,
  ConnectedSourceStore,
  ConnectSourceInput,
  PositionValuationUpdate,
  SourcePositionInput,
  ValuationFreshness,
} from "./connected-source-store";
export type {
  CorrectionBeforeMoney,
  CorrectionEdit,
  CorrectionEditKind,
  CorrectionMode,
  CorrectionPlan,
  CorrectionRevalidation,
} from "./correction-plan";
export type {
  AddBalanceAnchorInput,
  AddBalanceRebaselineInput,
  AddEarlyRepaymentInput,
  AddInterestRateRevisionInput,
  AmortizationPlanRecord,
  BalanceAnchorRecord,
  BalanceRebaselineRecord,
  CreateAmortizationPlanInput,
  EarlyRepaymentRecord,
  InterestRateRevisionRecord,
  LiabilityStore,
  UpdateAmortizationPlanInput,
  UpdateBalanceAnchorInput,
  UpdateBalanceRebaselineInput,
  UpdateEarlyRepaymentInput,
  UpdateInterestRateRevisionInput,
  UpdateLiabilityInput,
} from "./liability-store";
export type {
  OperationsStore,
  UpdateInvestmentOperationInput,
  ValueUpdateCommand,
} from "./operations-store";
export type {
  PositionView,
  SaveSnapshotInput,
  ScopedPositionsWithDetails,
  SnapshotHoldingQuery,
  SnapshotHoldingRecord,
  SnapshotStore,
} from "./snapshot-store";
export type {
  ImportWorkspaceResult,
  InitializeWorkspaceInput,
  MemberOwnerships,
  WorkspaceStore,
} from "./workspace-store";

/**
 * Create a throwaway WorthlineStore backed by an in-memory SQLite database.
 * The full schema and forward-migration ladder (ADR-0002) are applied on
 * construction, so the store is immediately usable for testing.
 *
 * Each call produces an independent, isolated database — parallel tests are
 * safe and no files are left behind.  Callers must call store.close() when done
 * (or use withStore with the store directly).
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
 * `createWorthlineStore`.
 */
export async function createStoreFromSqlite(client: Client): Promise<WorthlineStore> {
  const migrateResult = await migrate(client);
  return buildStore(client, migrateResult);
}

export async function createWorthlineStore(
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
  const goalStore = createGoalStore(ctx);
  const exposureProfileStore = createExposureProfileStore(ctx);
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
    exposureProfiles: exposureProfileStore,
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
 */
export async function withStore<T>(
  run: (store: WorthlineStore) => T | Promise<T>,
  options: WorthlineStoreOptions = {},
): Promise<T> {
  const store = await createWorthlineStore(options);

  try {
    return await run(store);
  } finally {
    store.close();
  }
}

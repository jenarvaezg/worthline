import type {
  LiquidityTier,
  LocalPersistenceStatus,
} from "@worthline/domain";
import type {
  AssetPrice,
  CreateInvestmentOperationInput,
  CreateLiabilityInput,
  CreateManualAssetInput,
  ExportedAsset,
  ExportedLiability,
  ExportedSnapshot,
  FireScopeConfig,
  InvestmentOperation,
  Liability,
  ManualValuePoint,
  Member,
  MemberGroup,
  ManualAsset,
  NetWorthSnapshot,
  OwnershipShare,
  SnapshotHoldingKind,
  SnapshotHoldingRow,
  WarningOverride,
  Workspace,
  WorkspaceExport,
  WorkspaceMode,
} from "@worthline/domain";
import {
  assertSnapshotHoldingsReconcile,
  buildSnapshotAtDate,
  createInvestmentOperation,
  createLiability,
  createWorkspace,
  historicalCapturedAt,
  listScopeOptions,
  recalculateSnapshotForAsset,
  serializeWorkspaceExport,
} from "@worthline/domain";
import Database from "better-sqlite3";
import type { Database as DatabaseConnection } from "better-sqlite3";
import { asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  appSettings,
  assetOperations,
  assetOwnerships,
  assetPriceCache,
  assets,
  auditLog,
  investmentAssets,
  liabilities,
  liabilityOwnerships,
  memberGroupMembers,
  memberGroups,
  members,
  workspace as workspaceTable,
} from "./schema";
import {
  createAssetStore,
  type AssetStore,
  type CreateInvestmentAssetInput,
  type InvestmentAssetFull,
  type InvestmentAssetMeta,
  type UpdateAssetInput,
  type UpdateInvestmentAssetInput,
} from "./asset-store";
import { migrate } from "./migrate";
import {
  createSnapshotStore,
  readSnapshotHoldings,
  readSnapshots,
  type PositionView,
  type SaveSnapshotInput,
  type SnapshotHoldingQuery,
  type SnapshotHoldingRecord,
  type SnapshotStore,
} from "./snapshot-store";
import {
  createStoreContext,
  groupOwnershipByOwner,
  hardDeleteAssetTx,
  readAllOperations,
  readAssetOwnerships,
  readAssets,
  toOperation,
} from "./store-context";

export type {
  AssetStore,
  CreateInvestmentAssetInput,
  InvestmentAssetFull,
  InvestmentAssetMeta,
  UpdateAssetInput,
  UpdateInvestmentAssetInput,
} from "./asset-store";
export type {
  PositionView,
  SaveSnapshotInput,
  SnapshotHoldingQuery,
  SnapshotHoldingRecord,
  SnapshotStore,
} from "./snapshot-store";

const bootstrapKey = "bootstrap.last_healthcheck_at";

/**
 * Every workspace table, children before parents so FK constraints hold
 * mid-transaction. Shared by resetWorkspace and importWorkspace — the two
 * full-replace paths — so the delete list can never drift between them.
 * Includes audit_log and app_settings: a full replace erases history too.
 */
const WORKSPACE_TABLES = [
  "snapshot_holdings",
  "snapshots",
  "asset_operations",
  "asset_price_cache",
  "investment_assets",
  "asset_ownerships",
  "liability_ownerships",
  "warning_overrides",
  "audit_log",
  "liabilities",
  "assets",
  "member_group_members",
  "member_groups",
  "members",
  "workspace",
  "app_settings",
] as const;

export interface BootstrapHealthcheckOptions {
  databasePath?: string;
  dataDir?: string;
  now?: () => Date;
}

export interface WorthlineStoreOptions {
  databasePath?: string;
  dataDir?: string;
}

export interface InitializeWorkspaceInput {
  mode: WorkspaceMode;
  members: Member[];
  groups?: MemberGroup[];
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TrashView {
  assets: Array<{ id: string; name: string }>;
  liabilities: Array<{ id: string; name: string }>;
}

/** One confirmed value change from a value-update pass. */
export interface ValueUpdateCommand {
  id: string;
  newValueMinor: number;
}

/** Fields that can be changed when editing an existing liability. */
export interface UpdateLiabilityInput {
  name?: string;
  type?: "mortgage" | "debt";
  associatedAssetId?: string | null;
  ownership?: OwnershipShare[];
}

/** Holdings a member still owns a share of — blocks the member's hard delete. */
export interface MemberOwnerships {
  assets: Array<{ id: string; name: string }>;
  liabilities: Array<{ id: string; name: string }>;
}

export interface WorthlineStore {
  acknowledgeWarning: (code: string, entityId: string) => number;
  batchApplyValueUpdates: (commands: ValueUpdateCommand[]) => void;
  batchApplyAllValueUpdates: (
    assetCommands: ValueUpdateCommand[],
    liabilityCommands: ValueUpdateCommand[],
  ) => void;
  reactivateMember: (memberId: string) => void;
  close: () => void;
  createInvestmentAsset: (input: CreateInvestmentAssetInput) => void;
  readInvestmentAssetById: (assetId: string) => InvestmentAssetFull | null;
  updateInvestmentAsset: (input: UpdateInvestmentAssetInput) => void;
  createLiability: (input: CreateLiabilityInput) => void;
  createManualAsset: (input: CreateManualAssetInput) => void;
  createMember: (member: Member) => void;
  /** Delete an operation. Returns the deleted operation's asset id and date, or null if not found. */
  deleteOperation: (operationId: string) => { assetId: string; executedAt: string } | null;
  disableMember: (memberId: string, disabledAt: string) => void;
  /** Hard-delete a trashed asset (live data + overrides; snapshots untouched). Returns 1 if removed, 0 if not found or not in trash. */
  hardDeleteAsset: (assetId: string) => number;
  /** Hard-delete a trashed liability. Returns 1 if removed, 0 if not found or not in trash. */
  hardDeleteLiability: (liabilityId: string) => number;
  /** Hard-delete every trashed holding atomically. Returns how many of each kind were removed. */
  emptyTrash: () => { assets: number; liabilities: number };
  /**
   * Serialize the entire workspace into the versioned export document
   * (ADR 0010): live state, snapshot history, the papelera, and the price
   * cache. Read-only — exporting never writes. The audit log is not a section.
   * Throws when no workspace has been initialized.
   */
  exportWorkspace: () => WorkspaceExport;
  /** Holdings (live or trashed) the member owns a share of. Empty ⇒ the member may be hard-deleted. */
  readMemberOwnerships: (memberId: string) => MemberOwnerships;
  /** Hard-delete a member. Returns 0 (no-op) unless the member is disabled and owns no share of any holding. */
  hardDeleteMember: (memberId: string) => number;
  /** Empty every table in one transaction, returning the workspace to onboarding. */
  resetWorkspace: () => void;
  initializeWorkspace: (input: InitializeWorkspaceInput) => void;
  /**
   * Atomically replace the entire workspace with an already-validated export
   * document (ADR 0010, #103): every table is emptied and the file's sections
   * are bulk-inserted with their ids preserved. Callers must validate the
   * document with parseWorkspaceExport first — this method does not re-parse.
   */
  importWorkspace: (doc: WorkspaceExport) => void;
  readAllPriceCacheEntries: () => AssetPrice[];
  readAssets: () => ManualAsset[];
  readInvestmentAssetsWithMeta: () => InvestmentAssetMeta[];
  readAuditLog: (filter?: { entityId?: string }) => AuditLogEntry[];
  readFireConfig: () => Record<string, FireScopeConfig>;
  readLiabilities: () => Liability[];
  readOperations: (assetId: string) => InvestmentOperation[];
  readPositions: (scopeId?: string) => PositionView[];
  readPriceCache: (assetId: string) => AssetPrice | null;
  readSnapshotHoldings: (query?: SnapshotHoldingQuery) => SnapshotHoldingRecord[];
  readSnapshots: (scopeId?: string) => NetWorthSnapshot[];
  readTrash: () => TrashView;
  readWarningOverrides: () => WarningOverride[];
  readWorkspace: () => Workspace | null;
  recordOperation: (input: CreateInvestmentOperationInput) => void;
  /**
   * Generate/recalculate historical snapshots after a backdated operation
   * change to one investment (ADR 0012, PRD #107). record(D) generates a fresh
   * snapshot at D when none exists there (and D is in the past), then
   * recalculates every existing snapshot dated ≥ D; delete(D) recalculates
   * every existing snapshot dated ≥ D. Recalculation only ever touches the
   * given asset's row in each snapshot, and skips legacy captures that have no
   * holding rows. Generation at D is a no-op when D is today or in the future
   * (the daily capture owns today).
   */
  rippleHistoricalSnapshotsForOperation: (params: {
    assetId: string;
    mode: "record" | "delete";
    operationDateKey: string;
    today: string;
  }) => void;
  /**
   * One-shot backfill (ADR 0012, PRD #107): generate a historical snapshot for
   * every past operation date that has no snapshot yet, across all scopes.
   * Existing snapshots are never recalculated — only gaps are filled. Idempotent.
   * `today` defaults to the current date; pass it to control the cut-off in tests.
   */
  backfillHistoricalSnapshots: (today?: string) => void;
  removeWarningOverride: (code: string, entityId: string) => void;
  restoreAsset: (assetId: string) => number;
  restoreLiability: (liabilityId: string) => number;
  saveFireConfig: (scopeId: string, config: FireScopeConfig) => void;
  saveSnapshot: (input: SaveSnapshotInput) => void;
  /** Focused snapshot & position store (Slice R1). The legacy saveSnapshot,
   *  readSnapshots, readSnapshotHoldings, and readPositions methods delegate here. */
  snapshots: SnapshotStore;
  /** Focused asset store (Slice R2). The legacy createManualAsset,
   *  createInvestmentAsset, readAssets, readInvestmentAssetById,
   *  readInvestmentAssetsWithMeta, updateAsset, updateAssetValuation,
   *  updateInvestmentAsset, softDeleteAsset, restoreAsset, and hardDeleteAsset
   *  methods delegate here. */
  assets: AssetStore;
  softDeleteAsset: (assetId: string, deletedAt: string) => number;
  softDeleteLiability: (liabilityId: string, deletedAt: string) => number;
  updateAsset: (assetId: string, input: UpdateAssetInput) => void;
  updateAssetValuation: (assetId: string, currentValueMinor: number) => void;
  updateLiability: (liabilityId: string, input: UpdateLiabilityInput) => void;
  updateLiabilityBalance: (liabilityId: string, balanceMinor: number) => void;
  updateMember: (member: Pick<Member, "id" | "name">) => void;
  upsertPrice: (price: AssetPrice) => void;
}

export function runBootstrapHealthcheck(
  options: BootstrapHealthcheckOptions = {},
): LocalPersistenceStatus {
  const databasePath = resolveDatabasePath(options);
  mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);
  try {
    migrate(sqlite);

    const db = drizzle(sqlite);
    const checkedAt = (options.now ?? (() => new Date()))().toISOString();

    db.insert(appSettings)
      .values({
        key: bootstrapKey,
        updatedAt: checkedAt,
        value: checkedAt,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          updatedAt: checkedAt,
          value: checkedAt,
        },
      })
      .run();

    const row = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, bootstrapKey))
      .get();

    if (!row) {
      throw new Error("SQLite bootstrap check did not persist an app setting.");
    }

    return {
      status: "ok",
      checkKey: bootstrapKey,
      checkedAt,
      checkValue: row.value,
      databasePath,
      displayPath: toDisplayPath(databasePath),
    };
  } finally {
    sqlite.close();
  }
}

/**
 * Create a throwaway WorthlineStore backed by an in-memory SQLite database.
 * The full schema and forward-migration ladder (ADR-0002) are applied on
 * construction, so the store is immediately usable for testing.
 *
 * Each call produces an independent, isolated database — parallel tests are
 * safe and no files are left behind.  Callers must call store.close() when done
 * (or use withStore with the store directly).
 */
export function createInMemoryStore(): WorthlineStore {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  return buildStore(sqlite);
}

export function createWorthlineStore(
  options: WorthlineStoreOptions = {},
): WorthlineStore {
  const databasePath = resolveDatabasePath(options);
  mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);
  migrate(sqlite);
  return buildStore(sqlite);
}

function buildStore(sqlite: DatabaseConnection): WorthlineStore {
  // Shared substrate for the extracted *-Store slices (R1–R5, PRD #120): the
  // connection, id generation, transaction wrapping, audit logging, and the
  // per-unit-of-work workspace cache all live in one place.
  const ctx = createStoreContext(sqlite, readWorkspace);
  const { writeAuditEntry } = ctx;
  const snapshotStore = createSnapshotStore(ctx);
  const assetStore = createAssetStore(ctx);

  // Hard-delete one trashed liability in the caller's transaction. FK cascade
  // takes its ownerships; snapshots stay frozen. Returns rows removed.
  const hardDeleteLiabilityTx = (liabilityId: string): number => {
    const row = sqlite
      .prepare(`SELECT name, type, deleted_at AS deletedAt FROM liabilities WHERE id = ?`)
      .get(liabilityId) as
      | { name: string; type: string; deletedAt: string | null }
      | undefined;

    if (!row || row.deletedAt === null) {
      return 0;
    }

    const ownership = sqlite
      .prepare(
        `SELECT member_id AS memberId, share_bps AS shareBps FROM liability_ownerships WHERE liability_id = ?`,
      )
      .all(liabilityId);

    sqlite.prepare(`DELETE FROM warning_overrides WHERE entity_id = ?`).run(liabilityId);
    const result = sqlite
      .prepare(`DELETE FROM liabilities WHERE id = ?`)
      .run(liabilityId);

    writeAuditEntry("hard_delete_liability", "liability", liabilityId, {
      name: row.name,
      ownership,
      type: row.type,
    });

    return result.changes;
  };

  const { getWorkspace, invalidateWorkspace } = ctx;

  const store: WorthlineStore = {
    close: () => {
      sqlite.close();
    },
    readInvestmentAssetById: (assetId) => assetStore.readInvestmentAssetById(assetId),
    updateInvestmentAsset: (input) => assetStore.updateInvestmentAsset(input),
    createLiability: (input) => {
      const workspace = getWorkspace();

      if (!workspace) {
        throw new Error("Workspace must be initialized before creating liabilities.");
      }

      const liability = createLiability(workspace, input);
      const insert = sqlite.transaction(() => {
        sqlite
          .prepare(
            `
            INSERT INTO liabilities (
              id,
              name,
              type,
              currency,
              current_balance_minor,
              associated_asset_id
            )
            VALUES (
              @id,
              @name,
              @type,
              @currency,
              @currentBalanceMinor,
              @associatedAssetId
            )
          `,
          )
          .run({
            associatedAssetId: liability.associatedAssetId ?? null,
            currency: liability.currency,
            currentBalanceMinor: liability.currentBalance.amountMinor,
            id: liability.id,
            name: liability.name,
            type: liability.type,
          });

        const insertOwnership = sqlite.prepare(`
          INSERT INTO liability_ownerships (liability_id, member_id, share_bps)
          VALUES (@liabilityId, @memberId, @shareBps)
        `);

        for (const share of liability.ownership) {
          insertOwnership.run({
            liabilityId: liability.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          });
        }
      });

      insert();
      writeAuditEntry("create_liability", "liability", liability.id);
    },
    createManualAsset: (input) => assetStore.createManualAsset(input),
    createInvestmentAsset: (input) => assetStore.createInvestmentAsset(input),
    createMember: (member) => {
      sqlite
        .prepare(
          `
          INSERT INTO members (id, name, disabled_at)
          VALUES (@id, @name, @disabledAt)
        `,
        )
        .run({
          disabledAt: member.disabledAt ?? null,
          id: member.id,
          name: member.name,
        });
      invalidateWorkspace();
    },
    disableMember: (memberId, disabledAt) => {
      sqlite
        .prepare(
          `
          UPDATE members
          SET disabled_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        )
        .run(disabledAt, memberId);
      invalidateWorkspace();
    },
    reactivateMember: (memberId) => {
      sqlite
        .prepare(
          `
          UPDATE members
          SET disabled_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        )
        .run(memberId);
      invalidateWorkspace();
    },
    initializeWorkspace: (input) => {
      const workspace = createWorkspace({
        baseCurrency: "EUR",
        members: input.members,
        mode: input.mode,
        ...(input.groups ? { groups: input.groups } : {}),
      });

      const initialize = sqlite.transaction(() => {
        sqlite.prepare("DELETE FROM member_group_members").run();
        sqlite.prepare("DELETE FROM member_groups").run();
        sqlite.prepare("DELETE FROM members").run();
        sqlite.prepare("DELETE FROM workspace").run();

        sqlite
          .prepare(
            `
            INSERT INTO workspace (id, mode, base_currency)
            VALUES ('default', @mode, @baseCurrency)
          `,
          )
          .run({
            baseCurrency: workspace.baseCurrency,
            mode: workspace.mode,
          });

        const insertMember = sqlite.prepare(`
          INSERT INTO members (id, name, disabled_at)
          VALUES (@id, @name, @disabledAt)
        `);

        for (const member of workspace.members) {
          insertMember.run({
            disabledAt: member.disabledAt ?? null,
            id: member.id,
            name: member.name,
          });
        }

        const insertGroup = sqlite.prepare(`
          INSERT INTO member_groups (id, name)
          VALUES (@id, @name)
        `);
        const insertGroupMember = sqlite.prepare(`
          INSERT INTO member_group_members (group_id, member_id, sort_order)
          VALUES (@groupId, @memberId, @sortOrder)
        `);

        for (const group of workspace.groups) {
          insertGroup.run({ id: group.id, name: group.name });

          group.memberIds.forEach((memberId, sortOrder) => {
            insertGroupMember.run({
              groupId: group.id,
              memberId,
              sortOrder,
            });
          });
        }
      });

      initialize();
      invalidateWorkspace();
    },
    readAssets: () => assetStore.readAssets(),
    assets: assetStore,
    readFireConfig: () => {
      const db = drizzle(sqlite);
      const row = db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, "fire.config"))
        .get();

      if (!row) {
        return {};
      }

      return JSON.parse(row.value) as Record<string, FireScopeConfig>;
    },
    readLiabilities: () => readLiabilities(sqlite, getWorkspace()),
    readOperations: (assetId) => readOperations(sqlite, assetId),
    readPositions: (scopeId) => snapshotStore.readPositions(scopeId),
    readSnapshots: (scopeId) => snapshotStore.readSnapshots(scopeId),
    snapshots: snapshotStore,
    readWorkspace: () => getWorkspace(),
    recordOperation: (input) => {
      const operation = createInvestmentOperation(input);

      sqlite
        .prepare(
          `
          INSERT INTO asset_operations (
            id,
            asset_id,
            kind,
            executed_at,
            units,
            price_per_unit,
            currency,
            fees_minor
          )
          VALUES (
            @id,
            @assetId,
            @kind,
            @executedAt,
            @units,
            @pricePerUnit,
            @currency,
            @feesMinor
          )
        `,
        )
        .run({
          assetId: operation.assetId,
          currency: operation.currency,
          executedAt: operation.executedAt,
          feesMinor: operation.feesMinor,
          id: operation.id,
          kind: operation.kind,
          pricePerUnit: operation.pricePerUnit,
          units: operation.units,
        });
    },
    saveFireConfig: (scopeId, config) => {
      const db = drizzle(sqlite);
      const existing = db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, "fire.config"))
        .get();

      const current: Record<string, FireScopeConfig> = existing
        ? (JSON.parse(existing.value) as Record<string, FireScopeConfig>)
        : {};
      const merged = { ...current, [scopeId]: config };
      const updatedAt = new Date().toISOString();

      db.insert(appSettings)
        .values({ key: "fire.config", updatedAt, value: JSON.stringify(merged) })
        .onConflictDoUpdate({
          set: { updatedAt, value: JSON.stringify(merged) },
          target: appSettings.key,
        })
        .run();
    },
    saveSnapshot: (input) => snapshotStore.saveSnapshot(input),
    readSnapshotHoldings: (query) => snapshotStore.readSnapshotHoldings(query),
    exportWorkspace: () => buildWorkspaceExport(sqlite, getWorkspace()),
    batchApplyValueUpdates: (commands) => {
      if (commands.length === 0) return;

      const applyAll = sqlite.transaction(() => {
        const update = sqlite.prepare(
          `UPDATE assets SET current_value_minor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        );

        for (const cmd of commands) {
          if (!Number.isInteger(cmd.newValueMinor)) {
            throw new Error("Money must be stored as integer minor units.");
          }
          update.run(cmd.newValueMinor, cmd.id);
          writeAuditEntry("update_valuation", "asset", cmd.id, {
            currentValueMinor: cmd.newValueMinor,
          });
        }
      });

      applyAll();
    },
    batchApplyAllValueUpdates: (assetCommands, liabilityCommands) => {
      const allCommands = [...assetCommands, ...liabilityCommands];
      if (allCommands.length === 0) return;

      // Validate ALL amounts before any write.
      for (const cmd of allCommands) {
        if (!Number.isInteger(cmd.newValueMinor)) {
          throw new Error("Money must be stored as integer minor units.");
        }
      }

      const applyAll = sqlite.transaction(() => {
        const updateAsset = sqlite.prepare(
          `UPDATE assets SET current_value_minor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        );
        const updateLiability = sqlite.prepare(
          `UPDATE liabilities SET current_balance_minor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        );

        for (const cmd of assetCommands) {
          updateAsset.run(cmd.newValueMinor, cmd.id);
          writeAuditEntry("update_valuation", "asset", cmd.id, {
            currentValueMinor: cmd.newValueMinor,
          });
        }
        for (const cmd of liabilityCommands) {
          updateLiability.run(cmd.newValueMinor, cmd.id);
          writeAuditEntry("update_balance", "liability", cmd.id, {
            balanceMinor: cmd.newValueMinor,
          });
        }
      });

      applyAll();
    },
    updateAsset: (assetId, input) => assetStore.updateAsset(assetId, input),
    updateAssetValuation: (assetId, currentValueMinor) =>
      assetStore.updateAssetValuation(assetId, currentValueMinor),
    updateLiability: (liabilityId, input) => {
      const updates: string[] = [];
      const params: unknown[] = [];

      if (input.name !== undefined) {
        updates.push("name = ?");
        params.push(input.name);
      }

      if (input.type !== undefined) {
        updates.push("type = ?");
        params.push(input.type);
      }

      if (input.associatedAssetId !== undefined) {
        updates.push("associated_asset_id = ?");
        params.push(input.associatedAssetId);
      }

      const editLiability = sqlite.transaction(() => {
        if (updates.length > 0) {
          updates.push("updated_at = CURRENT_TIMESTAMP");
          params.push(liabilityId);
          sqlite
            .prepare(`UPDATE liabilities SET ${updates.join(", ")} WHERE id = ?`)
            .run(...params);
        }

        if (input.ownership !== undefined) {
          sqlite
            .prepare(`DELETE FROM liability_ownerships WHERE liability_id = ?`)
            .run(liabilityId);

          const insertOwnership = sqlite.prepare(`
            INSERT INTO liability_ownerships (liability_id, member_id, share_bps)
            VALUES (@liabilityId, @memberId, @shareBps)
          `);

          for (const share of input.ownership) {
            insertOwnership.run({
              liabilityId,
              memberId: share.memberId,
              shareBps: share.shareBps,
            });
          }
        }
      });

      editLiability();
      writeAuditEntry("update_liability", "liability", liabilityId, {
        ...input,
        ownership: undefined,
      });
    },
    updateLiabilityBalance: (liabilityId, balanceMinor) => {
      if (!Number.isInteger(balanceMinor)) {
        throw new Error("Money must be stored as integer minor units.");
      }

      sqlite
        .prepare(
          `
          UPDATE liabilities
          SET current_balance_minor = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        )
        .run(balanceMinor, liabilityId);
      writeAuditEntry("update_balance", "liability", liabilityId, { balanceMinor });
    },
    updateMember: (member) => {
      sqlite
        .prepare(
          `
          UPDATE members
          SET name = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        )
        .run(member.name, member.id);
      invalidateWorkspace();
    },
    readPriceCache: (assetId) => {
      const db = drizzle(sqlite);
      const row = db
        .select()
        .from(assetPriceCache)
        .where(eq(assetPriceCache.assetId, assetId))
        .get();

      if (!row) return null;

      return {
        assetId: row.assetId,
        currency: row.currency,
        fetchedAt: row.fetchedAt,
        freshnessState: row.freshnessState,
        price: row.price,
        source: row.source,
        ...(row.priceDate ? { priceDate: row.priceDate } : {}),
        ...(row.staleReason ? { staleReason: row.staleReason } : {}),
      };
    },
    readInvestmentAssetsWithMeta: () => assetStore.readInvestmentAssetsWithMeta(),
    readAllPriceCacheEntries: () => {
      const db = drizzle(sqlite);
      const rows = db.select().from(assetPriceCache).all();

      return rows.map((row) => ({
        assetId: row.assetId,
        currency: row.currency,
        fetchedAt: row.fetchedAt,
        freshnessState: row.freshnessState,
        price: row.price,
        source: row.source,
        ...(row.priceDate ? { priceDate: row.priceDate } : {}),
        ...(row.staleReason ? { staleReason: row.staleReason } : {}),
      }));
    },
    upsertPrice: (price) => {
      const db = drizzle(sqlite);
      const now = new Date().toISOString();

      db.insert(assetPriceCache)
        .values({
          assetId: price.assetId,
          currency: price.currency,
          fetchedAt: price.fetchedAt,
          freshnessState: price.freshnessState,
          price: price.price,
          priceDate: price.priceDate ?? null,
          source: price.source,
          staleReason: price.staleReason ?? null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: assetPriceCache.assetId,
          set: {
            currency: price.currency,
            fetchedAt: price.fetchedAt,
            freshnessState: price.freshnessState,
            price: price.price,
            priceDate: price.priceDate ?? null,
            source: price.source,
            staleReason: price.staleReason ?? null,
            updatedAt: now,
          },
        })
        .run();
    },
    softDeleteAsset: (assetId, deletedAt) => assetStore.softDeleteAsset(assetId, deletedAt),
    restoreAsset: (assetId) => assetStore.restoreAsset(assetId),
    acknowledgeWarning: (code, entityId) => {
      const result = sqlite
        .prepare(
          `INSERT INTO warning_overrides (code, entity_id) VALUES (?, ?)
           ON CONFLICT(code, entity_id) DO NOTHING`,
        )
        .run(code, entityId);
      if (result.changes > 0) {
        writeAuditEntry("acknowledge_warning", "asset", entityId, { code });
      }
      return result.changes;
    },
    removeWarningOverride: (code, entityId) => {
      sqlite
        .prepare(`DELETE FROM warning_overrides WHERE code = ? AND entity_id = ?`)
        .run(code, entityId);
      writeAuditEntry("unacknowledge_warning", "asset", entityId, { code });
    },
    readWarningOverrides: () => {
      const rows = sqlite
        .prepare(`SELECT code, entity_id AS entityId FROM warning_overrides`)
        .all() as Array<{ code: string; entityId: string }>;

      return rows.map((row) => ({ code: row.code, entityId: row.entityId }));
    },
    readTrash: () => ({
      assets: sqlite
        .prepare(`SELECT id, name FROM assets WHERE deleted_at IS NOT NULL ORDER BY name`)
        .all() as Array<{ id: string; name: string }>,
      liabilities: sqlite
        .prepare(
          `SELECT id, name FROM liabilities WHERE deleted_at IS NOT NULL ORDER BY name`,
        )
        .all() as Array<{ id: string; name: string }>,
    }),
    softDeleteLiability: (liabilityId, deletedAt) => {
      const result = sqlite
        .prepare(`UPDATE liabilities SET deleted_at = ? WHERE id = ?`)
        .run(deletedAt, liabilityId);
      if (result.changes > 0) {
        writeAuditEntry("delete_liability", "liability", liabilityId, { deletedAt });
      }
      return result.changes;
    },
    restoreLiability: (liabilityId) => {
      const result = sqlite
        .prepare(
          `UPDATE liabilities SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`,
        )
        .run(liabilityId);
      if (result.changes > 0) {
        writeAuditEntry("restore_liability", "liability", liabilityId);
      }
      return result.changes;
    },
    hardDeleteAsset: (assetId) => assetStore.hardDeleteAsset(assetId),
    hardDeleteLiability: (liabilityId) =>
      sqlite.transaction(() => hardDeleteLiabilityTx(liabilityId))(),
    emptyTrash: () =>
      sqlite.transaction(() => {
        const trashedAssets = sqlite
          .prepare(`SELECT id FROM assets WHERE deleted_at IS NOT NULL`)
          .all() as Array<{ id: string }>;
        const trashedLiabilities = sqlite
          .prepare(`SELECT id FROM liabilities WHERE deleted_at IS NOT NULL`)
          .all() as Array<{ id: string }>;

        let assets = 0;
        let liabilities = 0;
        for (const row of trashedAssets) assets += hardDeleteAssetTx(ctx, row.id);
        for (const row of trashedLiabilities)
          liabilities += hardDeleteLiabilityTx(row.id);

        return { assets, liabilities };
      })(),
    deleteOperation: (operationId) => {
      const row = sqlite
        .prepare(
          `SELECT asset_id AS assetId, kind, executed_at AS executedAt, units,
                  price_per_unit AS pricePerUnit, currency, fees_minor AS feesMinor
           FROM asset_operations WHERE id = ?`,
        )
        .get(operationId) as
        | {
            assetId: string;
            kind: string;
            executedAt: string;
            units: string;
            pricePerUnit: string;
            currency: string;
            feesMinor: number;
          }
        | undefined;

      if (!row) {
        return null;
      }

      sqlite.prepare(`DELETE FROM asset_operations WHERE id = ?`).run(operationId);

      // Audit against the owning asset so the deletion shows in its history;
      // the full operation is recorded, making manual re-entry a de facto undo.
      writeAuditEntry("delete_operation", "asset", row.assetId, {
        currency: row.currency,
        executedAt: row.executedAt,
        feesMinor: row.feesMinor,
        kind: row.kind,
        operationId,
        pricePerUnit: row.pricePerUnit,
        units: row.units,
      });

      return { assetId: row.assetId, executedAt: row.executedAt };
    },
    readMemberOwnerships: (memberId) => ({
      assets: sqlite
        .prepare(
          `SELECT a.id, a.name FROM asset_ownerships o
           JOIN assets a ON a.id = o.asset_id
           WHERE o.member_id = ? ORDER BY a.name`,
        )
        .all(memberId) as Array<{ id: string; name: string }>,
      liabilities: sqlite
        .prepare(
          `SELECT l.id, l.name FROM liability_ownerships o
           JOIN liabilities l ON l.id = o.liability_id
           WHERE o.member_id = ? ORDER BY l.name`,
        )
        .all(memberId) as Array<{ id: string; name: string }>,
    }),
    hardDeleteMember: (memberId) => {
      const member = sqlite
        .prepare(`SELECT name, disabled_at AS disabledAt FROM members WHERE id = ?`)
        .get(memberId) as { name: string; disabledAt: string | null } | undefined;

      // Only a disabled member owning no share of any holding (trashed ones
      // included) may be destroyed — mirrors the FK `restrict` as a domain rule
      // instead of letting the constraint throw.
      if (!member || member.disabledAt === null) {
        return 0;
      }

      const owned = sqlite
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM asset_ownerships WHERE member_id = @id)
           + (SELECT COUNT(*) FROM liability_ownerships WHERE member_id = @id) AS n`,
        )
        .get({ id: memberId }) as { n: number };

      if (owned.n > 0) {
        return 0;
      }

      const result = sqlite.prepare(`DELETE FROM members WHERE id = ?`).run(memberId);

      if (result.changes > 0) {
        writeAuditEntry("hard_delete_member", "member", memberId, { name: member.name });
        invalidateWorkspace();
      }

      return result.changes;
    },
    resetWorkspace: () => {
      // WORKSPACE_TABLES is ordered children before parents so FK constraints
      // hold mid-transaction. The file and schema survive; the next read finds
      // no workspace and the app falls back to onboarding. Unlike a hard
      // delete, the reset erases history.
      sqlite.transaction(() => {
        for (const table of WORKSPACE_TABLES) {
          sqlite.prepare(`DELETE FROM ${table}`).run();
        }
      })();

      invalidateWorkspace();
    },
    importWorkspace: (doc) => {
      const importAll = sqlite.transaction(() => {
        // Full replace (ADR 0010): same wipe as resetWorkspace, then the
        // file's sections are bulk-inserted with their ids preserved — raw
        // INSERTs on purpose, never the domain constructors that mint ids.
        for (const table of WORKSPACE_TABLES) {
          sqlite.prepare(`DELETE FROM ${table}`).run();
        }

        sqlite
          .prepare(
            `INSERT INTO workspace (id, mode, base_currency)
             VALUES ('default', @mode, @baseCurrency)`,
          )
          .run({
            baseCurrency: doc.workspace.baseCurrency,
            mode: doc.workspace.mode,
          });

        const insertMember = sqlite.prepare(`
          INSERT INTO members (id, name, disabled_at)
          VALUES (@id, @name, @disabledAt)
        `);

        for (const member of doc.members) {
          insertMember.run({
            disabledAt: member.disabledAt ?? null,
            id: member.id,
            name: member.name,
          });
        }

        const insertGroup = sqlite.prepare(`
          INSERT INTO member_groups (id, name)
          VALUES (@id, @name)
        `);
        const insertGroupMember = sqlite.prepare(`
          INSERT INTO member_group_members (group_id, member_id, sort_order)
          VALUES (@groupId, @memberId, @sortOrder)
        `);

        for (const group of doc.groups) {
          insertGroup.run({ id: group.id, name: group.name });

          group.memberIds.forEach((memberId, sortOrder) => {
            insertGroupMember.run({ groupId: group.id, memberId, sortOrder });
          });
        }

        const insertAsset = sqlite.prepare(`
          INSERT INTO assets (
            id, name, type, currency, current_value_minor,
            liquidity_tier, is_primary_residence, deleted_at
          )
          VALUES (
            @id, @name, @type, @currency, @currentValueMinor,
            @liquidityTier, @isPrimaryResidence, @deletedAt
          )
        `);
        const insertAssetOwnership = sqlite.prepare(`
          INSERT INTO asset_ownerships (asset_id, member_id, share_bps)
          VALUES (@assetId, @memberId, @shareBps)
        `);
        const insertInvestmentMeta = sqlite.prepare(`
          INSERT INTO investment_assets (
            asset_id, unit_symbol, isin, price_provider, provider_symbol,
            manual_price_per_unit, manual_priced_at
          )
          VALUES (
            @assetId, @unitSymbol, @isin, @priceProvider, @providerSymbol,
            @manualPricePerUnit, @manualPricedAt
          )
        `);

        const writeAsset = (asset: ExportedAsset): void => {
          insertAsset.run({
            currency: asset.currency,
            // Investments are stored at zero like createInvestmentAsset does:
            // their value is derived from operations and prices on read, never
            // stored (ADR 0006). Hand-valued kinds carry the file's value.
            currentValueMinor:
              asset.type === "investment" ? 0 : (asset.currentValue?.amountMinor ?? 0),
            deletedAt: asset.deletedAt ?? null,
            id: asset.id,
            isPrimaryResidence: asset.isPrimaryResidence ? 1 : 0,
            liquidityTier: asset.liquidityTier,
            name: asset.name,
            type: asset.type,
          });

          for (const share of asset.ownership) {
            insertAssetOwnership.run({
              assetId: asset.id,
              memberId: share.memberId,
              shareBps: share.shareBps,
            });
          }

          // Every investment gets its metadata row (all-null when the file
          // carries none) — read paths expect the row to exist.
          if (asset.type === "investment") {
            insertInvestmentMeta.run({
              assetId: asset.id,
              isin: asset.investment?.isin ?? null,
              manualPricePerUnit: asset.investment?.manualPricePerUnit ?? null,
              manualPricedAt: asset.investment?.manualPricedAt ?? null,
              priceProvider: asset.investment?.priceProvider ?? null,
              providerSymbol: asset.investment?.providerSymbol ?? null,
              unitSymbol: asset.investment?.unitSymbol ?? null,
            });
          }
        };

        // Trash entries land in the same tables with deleted_at set. All
        // assets go in before liabilities so associated_asset_id can point at
        // a trashed asset without tripping the FK.
        for (const asset of doc.assets) writeAsset(asset);
        for (const asset of doc.trash.assets) writeAsset(asset);

        const insertLiability = sqlite.prepare(`
          INSERT INTO liabilities (
            id, name, type, currency, current_balance_minor,
            associated_asset_id, deleted_at
          )
          VALUES (
            @id, @name, @type, @currency, @currentBalanceMinor,
            @associatedAssetId, @deletedAt
          )
        `);
        const insertLiabilityOwnership = sqlite.prepare(`
          INSERT INTO liability_ownerships (liability_id, member_id, share_bps)
          VALUES (@liabilityId, @memberId, @shareBps)
        `);

        const writeLiability = (liability: ExportedLiability): void => {
          insertLiability.run({
            associatedAssetId: liability.associatedAssetId ?? null,
            currency: liability.currency,
            currentBalanceMinor: liability.currentBalance.amountMinor,
            deletedAt: liability.deletedAt ?? null,
            id: liability.id,
            name: liability.name,
            type: liability.type,
          });

          for (const share of liability.ownership) {
            insertLiabilityOwnership.run({
              liabilityId: liability.id,
              memberId: share.memberId,
              shareBps: share.shareBps,
            });
          }
        };

        for (const liability of doc.liabilities) writeLiability(liability);
        for (const liability of doc.trash.liabilities) writeLiability(liability);

        const insertOperation = sqlite.prepare(`
          INSERT INTO asset_operations (
            id, asset_id, kind, executed_at, units,
            price_per_unit, currency, fees_minor
          )
          VALUES (
            @id, @assetId, @kind, @executedAt, @units,
            @pricePerUnit, @currency, @feesMinor
          )
        `);

        for (const operation of doc.operations) {
          insertOperation.run({
            assetId: operation.assetId,
            currency: operation.currency,
            executedAt: operation.executedAt,
            feesMinor: operation.feesMinor,
            id: operation.id,
            kind: operation.kind,
            pricePerUnit: operation.pricePerUnit,
            units: operation.units,
          });
        }

        const insertOverride = sqlite.prepare(`
          INSERT INTO warning_overrides (code, entity_id)
          VALUES (@code, @entityId)
        `);

        for (const override of doc.warningOverrides) {
          insertOverride.run({ code: override.code, entityId: override.entityId });
        }

        // The whole fire config record lands in the single app_settings row
        // exactly as saveFireConfig leaves it.
        if (Object.keys(doc.fireConfig).length > 0) {
          sqlite
            .prepare(
              `INSERT INTO app_settings (key, value, updated_at)
               VALUES ('fire.config', @value, @updatedAt)`,
            )
            .run({
              updatedAt: new Date().toISOString(),
              value: JSON.stringify(doc.fireConfig),
            });
        }

        const insertSnapshot = sqlite.prepare(`
          INSERT INTO snapshots (
            id, scope_id, scope_label, captured_at, date_key, month_key,
            is_monthly_close, currency, total_net_worth_minor,
            liquid_net_worth_minor, housing_equity_minor, gross_assets_minor,
            debts_minor, warnings_json
          )
          VALUES (
            @id, @scopeId, @scopeLabel, @capturedAt, @dateKey, @monthKey,
            @isMonthlyClose, @currency, @totalNetWorthMinor,
            @liquidNetWorthMinor, @housingEquityMinor, @grossAssetsMinor,
            @debtsMinor, @warningsJson
          )
        `);
        const insertHolding = sqlite.prepare(`
          INSERT INTO snapshot_holdings (
            id, snapshot_id, holding_id, kind, label,
            liquidity_tier, value_minor, units, unit_price
          )
          VALUES (
            @id, @snapshotId, @holdingId, @kind, @label,
            @liquidityTier, @valueMinor, @units, @unitPrice
          )
        `);

        for (const snapshot of doc.snapshots) {
          // Defence in depth (ADR 0008): the parser already checked this, but
          // a capture whose rows contradict its own figures must never persist.
          if (snapshot.holdings.length > 0) {
            assertSnapshotHoldingsReconcile(snapshot.holdings, {
              debtsMinor: snapshot.debts.amountMinor,
              grossAssetsMinor: snapshot.grossAssets.amountMinor,
            });
          }

          insertSnapshot.run({
            capturedAt: snapshot.capturedAt,
            currency: snapshot.totalNetWorth.currency,
            dateKey: snapshot.dateKey,
            debtsMinor: snapshot.debts.amountMinor,
            grossAssetsMinor: snapshot.grossAssets.amountMinor,
            housingEquityMinor: snapshot.housingEquity.amountMinor,
            id: snapshot.id,
            isMonthlyClose: snapshot.isMonthlyClose ? 1 : 0,
            liquidNetWorthMinor: snapshot.liquidNetWorth.amountMinor,
            monthKey: snapshot.monthKey,
            scopeId: snapshot.scopeId,
            scopeLabel: snapshot.scopeLabel,
            totalNetWorthMinor: snapshot.totalNetWorth.amountMinor,
            warningsJson: JSON.stringify(snapshot.warnings),
          });

          // The file's holding rows carry no row ids — mint fresh ones.
          for (const row of snapshot.holdings) {
            insertHolding.run({
              holdingId: row.holdingId,
              id: randomUUID(),
              kind: row.kind,
              label: row.label,
              liquidityTier: row.liquidityTier,
              snapshotId: snapshot.id,
              unitPrice: row.unitPrice ?? null,
              units: row.units ?? null,
              valueMinor: row.valueMinor,
            });
          }
        }

        const insertPrice = sqlite.prepare(`
          INSERT INTO asset_price_cache (
            asset_id, currency, price, source, price_date,
            fetched_at, freshness_state, stale_reason
          )
          VALUES (
            @assetId, @currency, @price, @source, @priceDate,
            @fetchedAt, @freshnessState, @staleReason
          )
        `);

        for (const price of doc.priceCache) {
          insertPrice.run({
            assetId: price.assetId,
            currency: price.currency,
            fetchedAt: price.fetchedAt,
            freshnessState: price.freshnessState,
            price: price.price,
            priceDate: price.priceDate ?? null,
            source: price.source,
            staleReason: price.staleReason ?? null,
          });
        }

        // One audit entry inside the transaction: a failed import leaves no
        // trace, a successful one starts the fresh log with its section counts.
        writeAuditEntry("import_workspace", "workspace", "default", {
          assets: doc.assets.length,
          fireScopes: Object.keys(doc.fireConfig).length,
          groups: doc.groups.length,
          liabilities: doc.liabilities.length,
          members: doc.members.length,
          operations: doc.operations.length,
          priceCache: doc.priceCache.length,
          snapshots: doc.snapshots.length,
          trashAssets: doc.trash.assets.length,
          trashLiabilities: doc.trash.liabilities.length,
          warningOverrides: doc.warningOverrides.length,
        });
      });

      importAll();
      invalidateWorkspace();

      // Gap-fill historical snapshots (ADR 0012, Slice 3 / #112): generate
      // snapshots for imported operation dates that have no snapshot in the
      // file. Imported snapshots are restored intact and never recalculated —
      // they were captured with real contemporaneous data. Runs outside the
      // import transaction so each save owns its own transaction.
      const importedWorkspace = getWorkspace();
      if (importedWorkspace) {
        const today = new Date().toISOString().slice(0, 10);
        try {
          gapFillHistoricalSnapshots(sqlite, importedWorkspace, store.saveSnapshot, today);
        } catch (error) {
          // The import itself already committed (ADR 0010). Gap-fill is a
          // best-effort post-step: surface its failure without rolling back a
          // successful import — the user can re-run the backfill later.
          console.error("Historical-snapshot gap-fill after import failed:", error);
        }
      }
    },
    readAuditLog: (filter) => {
      const db = drizzle(sqlite);
      const rows = filter?.entityId
        ? db
            .select()
            .from(auditLog)
            .where(eq(auditLog.entityId, filter.entityId))
            .orderBy(asc(auditLog.createdAt))
            .all()
        : db.select().from(auditLog).orderBy(asc(auditLog.createdAt)).all();

      return rows.map((row) => ({
        action: row.action,
        createdAt: row.createdAt,
        details: JSON.parse(row.detailsJson) as Record<string, unknown>,
        entityId: row.entityId,
        entityType: row.entityType,
        id: row.id,
      }));
    },
    rippleHistoricalSnapshotsForOperation: (params) => {
      const workspace = getWorkspace();
      if (!workspace) return;
      rippleHistoricalSnapshots(sqlite, workspace, store.saveSnapshot, params);
    },
    backfillHistoricalSnapshots: (today) => {
      const workspace = getWorkspace();
      if (!workspace) return;
      gapFillHistoricalSnapshots(
        sqlite,
        workspace,
        store.saveSnapshot,
        today ?? new Date().toISOString().slice(0, 10),
      );
    },
  };

  return store;
}

// ── Historical snapshots (ADR 0012, PRD #107) ────────────────────────────────

/** Inputs shared by every historical-snapshot reconstruction for a workspace. */
interface HistoricalSnapshotDeps {
  scopes: ReturnType<typeof listScopeOptions>;
  assets: ManualAsset[];
  liabilities: Liability[];
  operationsByAsset: Map<string, InvestmentOperation[]>;
  manualValueHistory: Map<string, ManualValuePoint[]>;
}

function buildHistoricalSnapshotDeps(
  sqlite: DatabaseConnection,
  workspace: Workspace,
): HistoricalSnapshotDeps {
  return {
    assets: readAssets(sqlite, workspace),
    liabilities: readLiabilities(sqlite, workspace),
    manualValueHistory: readManualValueHistory(sqlite),
    operationsByAsset: readAllOperations(sqlite),
    scopes: listScopeOptions(workspace),
  };
}

/**
 * Reconstruct the audit history of manual values/balances, keyed by holding id.
 *
 * The "last known value" basis for cash/housing/debts in a historical snapshot
 * (PRD #107): each `update_valuation` / `update_balance` audit entry is a dated
 * value point. The entry's `created_at` date is when the value became known.
 */
function readManualValueHistory(
  sqlite: DatabaseConnection,
): Map<string, ManualValuePoint[]> {
  const rows = drizzle(sqlite)
    .select()
    .from(auditLog)
    .orderBy(asc(auditLog.createdAt))
    .all();

  const history = new Map<string, ManualValuePoint[]>();

  for (const row of rows) {
    if (row.action !== "update_valuation" && row.action !== "update_balance") {
      continue;
    }

    let details: Record<string, unknown>;
    try {
      details = JSON.parse(row.detailsJson) as Record<string, unknown>;
    } catch {
      continue; // a single malformed audit row must not abort the whole ripple
    }
    const value =
      row.action === "update_valuation"
        ? details["currentValueMinor"]
        : details["balanceMinor"];

    if (typeof value !== "number") continue;

    const dateKey = (row.createdAt ?? "").slice(0, 10);
    if (!dateKey) continue;

    const points = history.get(row.entityId) ?? [];
    points.push({ dateKey, valueMinor: value });
    history.set(row.entityId, points);
  }

  return history;
}

/**
 * Ripple effect (ADR 0012): a backdated operation change regenerates the
 * snapshot at its date and recalculates the existing snapshots it affects.
 *
 * - record(D), D in the past: generate/overwrite the snapshot at D (the new
 *   operation supplies its own best price), then recalculate existing
 *   snapshots dated > D.
 * - delete(D): recalculate existing snapshots dated ≥ D (the snapshot at D was
 *   itself derived from the operation that just disappeared).
 *
 * Operations dated today or in the future never generate history — the daily
 * capture covers today and the future is not history. Recalculations honor the
 * unit price each snapshot already captured for an asset; only an asset absent
 * from a snapshot falls back to the last known operation price ≤ its date.
 */
function rippleHistoricalSnapshots(
  sqlite: DatabaseConnection,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => void,
  params: {
    assetId: string;
    mode: "record" | "delete";
    operationDateKey: string;
    today: string;
  },
): void {
  const { assetId, mode, operationDateKey, today } = params;

  // The operated asset's identity — read including trashed, since it existed on
  // the snapshot dates even if it was trashed afterwards (ADR 0012).
  const asset = readInvestmentIdentity(sqlite, assetId);
  if (!asset) return;
  const operations = readAllOperations(sqlite).get(assetId) ?? [];

  const deleteSnapshotById = sqlite.prepare("DELETE FROM snapshots WHERE id = ?");

  const apply = sqlite.transaction(() => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = readSnapshots(sqlite, scope.id);
      const existingByDate = new Map(existing.map((snap) => [snap.dateKey, snap]));

      // Generate a fresh whole-portfolio snapshot at the operation date when
      // recording into the past and none exists yet there.
      if (
        mode === "record" &&
        operationDateKey < today &&
        !existingByDate.has(operationDateKey)
      ) {
        const deps = buildHistoricalSnapshotDeps(sqlite, workspace);
        const built = buildSnapshotAtDate({
          assets: deps.assets,
          capturedAt: historicalCapturedAt(operationDateKey),
          id: `histsnap_${scope.id}_${operationDateKey}`,
          liabilities: deps.liabilities,
          manualValueHistory: deps.manualValueHistory,
          operationsByAsset: deps.operationsByAsset,
          scopeId: scope.id,
          scopeLabel: scope.label,
          targetDate: operationDateKey,
          workspace,
        });
        if (built) {
          saveSnapshot({ holdings: built.holdings, replace: false, snapshot: built.snapshot });
        }
      }

      // Recalculate every affected existing snapshot — only the operated
      // asset's row changes; all other frozen rows are preserved. (Both modes
      // recalculate ≥ D: record relies on the generate branch above for a
      // brand-new D, and recalculates an existing D in place here.)
      for (const snap of existing) {
        if (snap.dateKey < operationDateKey) continue;

        const frozenHoldings = readSnapshotHoldings(sqlite, {
          scopeId: scope.id,
          from: snap.dateKey,
          to: snap.dateKey,
        });

        // A legacy capture predating holdings (ADR 0008) has no rows to
        // recompute against — leave its frozen figures untouched.
        if (frozenHoldings.length === 0) continue;

        const recalculated = recalculateSnapshotForAsset({
          asset,
          frozenHoldings,
          operations,
          snapshot: snap,
          workspace,
        });

        if (recalculated) {
          saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          // No holdings remain (e.g. the deleted operation was the only basis):
          // drop the snapshot rather than leave it showing stale values.
          deleteSnapshotById.run(snap.id);
        }
      }
    }
  });

  apply();
}

/**
 * Read one investment asset's identity (ownership, currency, tier, name),
 * including trashed assets — historical reconstruction needs the identity of
 * holdings that existed on past dates even if they were trashed since.
 */
function readInvestmentIdentity(
  sqlite: DatabaseConnection,
  assetId: string,
): ManualAsset | null {
  const row = drizzle(sqlite)
    .select({
      id: assets.id,
      name: assets.name,
      type: assets.type,
      currency: assets.currency,
      liquidityTier: assets.liquidityTier,
      isPrimaryResidence: assets.isPrimaryResidence,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) return null;

  const ownership = drizzle(sqlite)
    .select({ memberId: assetOwnerships.memberId, shareBps: assetOwnerships.shareBps })
    .from(assetOwnerships)
    .where(eq(assetOwnerships.assetId, assetId))
    .all();

  return {
    currency: row.currency,
    currentValue: { amountMinor: 0, currency: row.currency },
    id: row.id,
    isPrimaryResidence: row.isPrimaryResidence === 1,
    liquidityTier: row.liquidityTier,
    name: row.name,
    ownership,
    type: row.type,
  };
}

/**
 * Fill historical-snapshot gaps after an import (ADR 0012, Slice 3 / #112):
 * generate a snapshot for each past operation date that has no snapshot in the
 * imported file. Imported snapshots are never touched. One pass, no per-
 * operation ripple — each date is reconstructed once from all operations ≤ it.
 */
function gapFillHistoricalSnapshots(
  sqlite: DatabaseConnection,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => void,
  today: string,
): void {
  const deps = buildHistoricalSnapshotDeps(sqlite, workspace);

  const eventDates = new Set<string>();
  for (const operations of deps.operationsByAsset.values()) {
    for (const operation of operations) {
      const dateKey = operation.executedAt.slice(0, 10);
      if (dateKey < today) eventDates.add(dateKey);
    }
  }
  const sortedDates = [...eventDates].sort();

  for (const scope of deps.scopes) {
    const existingDates = new Set(
      readSnapshots(sqlite, scope.id).map((snap) => snap.dateKey),
    );

    for (const dateKey of sortedDates) {
      if (existingDates.has(dateKey)) continue; // imported snapshot stays intact

      const built = buildSnapshotAtDate({
        assets: deps.assets,
        capturedAt: historicalCapturedAt(dateKey),
        id: `histsnap_${scope.id}_${dateKey}`,
        liabilities: deps.liabilities,
        manualValueHistory: deps.manualValueHistory,
        operationsByAsset: deps.operationsByAsset,
        scopeId: scope.id,
        scopeLabel: scope.label,
        targetDate: dateKey,
        workspace,
      });

      if (built) {
        saveSnapshot({ holdings: built.holdings, replace: false, snapshot: built.snapshot });
      }
    }
  }
}

/**
 * Run a unit of work against a freshly opened store and guarantee the SQLite
 * connection is closed afterwards — even if the callback throws. This is the one
 * home for the open/use/close lifecycle so callers never leak a connection.
 */
export function withStore<T>(
  run: (store: WorthlineStore) => T,
  options: WorthlineStoreOptions = {},
): T {
  const store = createWorthlineStore(options);

  try {
    return run(store);
  } finally {
    store.close();
  }
}

export function resolveDatabasePath(options: BootstrapHealthcheckOptions = {}): string {
  if (options.databasePath) {
    return resolve(options.databasePath);
  }

  if (process.env.WORTHLINE_DB_PATH) {
    return resolve(process.env.WORTHLINE_DB_PATH);
  }

  return join(resolveDataDir(options), "worthline.sqlite");
}

function readWorkspace(sqlite: DatabaseConnection): Workspace | null {
  const db = drizzle(sqlite);

  const workspaceRow = db
    .select({ baseCurrency: workspaceTable.baseCurrency, mode: workspaceTable.mode })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, "default"))
    .get();

  if (!workspaceRow) {
    return null;
  }

  const memberRows = db
    .select({ disabledAt: members.disabledAt, id: members.id, name: members.name })
    .from(members)
    .orderBy(asc(members.createdAt), asc(members.id))
    .all();

  const groupRows = db
    .select({ id: memberGroups.id, name: memberGroups.name })
    .from(memberGroups)
    .orderBy(asc(memberGroups.createdAt), asc(memberGroups.id))
    .all();

  const groups = groupRows.map((group) => {
    const groupMembers = db
      .select({ memberId: memberGroupMembers.memberId })
      .from(memberGroupMembers)
      .where(eq(memberGroupMembers.groupId, group.id))
      .orderBy(asc(memberGroupMembers.sortOrder))
      .all();

    return {
      id: group.id,
      memberIds: groupMembers.map((row) => row.memberId),
      name: group.name,
    };
  });

  return createWorkspace({
    baseCurrency: workspaceRow.baseCurrency,
    groups,
    members: memberRows.map((member) =>
      member.disabledAt
        ? {
            disabledAt: member.disabledAt,
            id: member.id,
            name: member.name,
          }
        : {
            id: member.id,
            name: member.name,
          },
    ),
    mode: workspaceRow.mode,
  });
}

function readOperations(
  sqlite: DatabaseConnection,
  assetId: string,
): InvestmentOperation[] {
  return drizzle(sqlite)
    .select()
    .from(assetOperations)
    .where(eq(assetOperations.assetId, assetId))
    .orderBy(asc(assetOperations.executedAt), asc(assetOperations.id))
    .all()
    .map(toOperation);
}

function readLiabilities(
  sqlite: DatabaseConnection,
  workspace: Workspace | null,
): Liability[] {
  if (!workspace) {
    return [];
  }

  const rows = drizzle(sqlite)
    .select({
      associatedAssetId: liabilities.associatedAssetId,
      balanceMinor: liabilities.currentBalanceMinor,
      currency: liabilities.currency,
      id: liabilities.id,
      name: liabilities.name,
      type: liabilities.type,
    })
    .from(liabilities)
    .where(isNull(liabilities.deletedAt))
    .orderBy(asc(liabilities.createdAt), asc(liabilities.id))
    .all();
  const ownershipByLiability = readLiabilityOwnerships(sqlite);

  return rows.map((row) =>
    createLiability(workspace, {
      balanceMinor: row.balanceMinor,
      currency: row.currency,
      id: row.id,
      name: row.name,
      ownership: ownershipByLiability.get(row.id) ?? [],
      type: row.type,
      ...(row.associatedAssetId ? { associatedAssetId: row.associatedAssetId } : {}),
    }),
  );
}

/** All liability ownership rows in one query, grouped by liability id. */
function readLiabilityOwnerships(
  sqlite: DatabaseConnection,
): Map<string, OwnershipShare[]> {
  const rows = drizzle(sqlite)
    .select({
      liabilityId: liabilityOwnerships.liabilityId,
      memberId: liabilityOwnerships.memberId,
      shareBps: liabilityOwnerships.shareBps,
    })
    .from(liabilityOwnerships)
    .orderBy(asc(liabilityOwnerships.liabilityId), asc(liabilityOwnerships.memberId))
    .all();

  return groupOwnershipByOwner(rows, (row) => row.liabilityId);
}

/**
 * Serialize the entire workspace into the versioned export document
 * (ADR 0010). Strictly read-only: every section is read from the tables and
 * the final assembly is delegated to the domain's serializeWorkspaceExport.
 * The audit log is deliberately not a section.
 */
function buildWorkspaceExport(
  sqlite: DatabaseConnection,
  workspace: Workspace | null,
): WorkspaceExport {
  if (!workspace) {
    throw new Error("Workspace must be initialized before exporting.");
  }

  const db = drizzle(sqlite);

  // Assets — live and trashed — with ownership and investment metadata.
  const assetRows = db
    .select()
    .from(assets)
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();
  const ownershipByAsset = readAssetOwnerships(sqlite);
  const investmentMetaByAsset = new Map(
    db
      .select()
      .from(investmentAssets)
      .all()
      .map((row) => [row.assetId, row] as const),
  );

  const toExportedAsset = (row: typeof assets.$inferSelect): ExportedAsset => {
    const meta = investmentMetaByAsset.get(row.id);

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      currency: row.currency,
      // Investments never carry a hand value — theirs is derived from
      // operations and prices (ADR 0006), so the file omits currentValue.
      ...(row.type === "investment"
        ? {}
        : {
            currentValue: { amountMinor: row.currentValueMinor, currency: row.currency },
          }),
      liquidityTier: row.liquidityTier,
      isPrimaryResidence: row.isPrimaryResidence === 1,
      ownership: ownershipByAsset.get(row.id) ?? [],
      ...(row.type === "investment" && meta
        ? {
            investment: {
              ...(meta.unitSymbol ? { unitSymbol: meta.unitSymbol } : {}),
              ...(meta.isin ? { isin: meta.isin } : {}),
              ...(meta.priceProvider ? { priceProvider: meta.priceProvider } : {}),
              ...(meta.providerSymbol ? { providerSymbol: meta.providerSymbol } : {}),
              ...(meta.manualPricePerUnit
                ? { manualPricePerUnit: meta.manualPricePerUnit }
                : {}),
              ...(meta.manualPricedAt ? { manualPricedAt: meta.manualPricedAt } : {}),
            },
          }
        : {}),
      ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
    };
  };

  // Liabilities — live and trashed — with ownership.
  const liabilityRows = db
    .select()
    .from(liabilities)
    .orderBy(asc(liabilities.createdAt), asc(liabilities.id))
    .all();
  const ownershipByLiability = readLiabilityOwnerships(sqlite);

  const toExportedLiability = (
    row: typeof liabilities.$inferSelect,
  ): ExportedLiability => ({
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    currentBalance: { amountMinor: row.currentBalanceMinor, currency: row.currency },
    ownership: ownershipByLiability.get(row.id) ?? [],
    ...(row.associatedAssetId ? { associatedAssetId: row.associatedAssetId } : {}),
    ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
  });

  // Operations for every investment asset — including trashed ones, so a
  // restore after import keeps their history.
  const operations = db
    .select()
    .from(assetOperations)
    .orderBy(asc(assetOperations.executedAt), asc(assetOperations.id))
    .all()
    .map(toOperation);

  const warningOverrideRows = sqlite
    .prepare(
      `SELECT code, entity_id AS entityId FROM warning_overrides ORDER BY code, entity_id`,
    )
    .all() as Array<{ code: string; entityId: string }>;

  const fireRow = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "fire.config"))
    .get();
  const fireConfig = fireRow
    ? (JSON.parse(fireRow.value) as Record<string, FireScopeConfig>)
    : {};

  // Snapshots across all scopes, each carrying its frozen holding rows.
  const holdingsBySnapshot = readHoldingRowsBySnapshot(sqlite);
  const exportedSnapshots: ExportedSnapshot[] = readSnapshots(sqlite).map((snapshot) => ({
    ...snapshot,
    holdings: holdingsBySnapshot.get(snapshot.id) ?? [],
  }));

  const priceCache: AssetPrice[] = db
    .select()
    .from(assetPriceCache)
    .orderBy(asc(assetPriceCache.assetId))
    .all()
    .map((row) => ({
      assetId: row.assetId,
      currency: row.currency,
      fetchedAt: row.fetchedAt,
      freshnessState: row.freshnessState,
      price: row.price,
      source: row.source,
      ...(row.priceDate ? { priceDate: row.priceDate } : {}),
      ...(row.staleReason ? { staleReason: row.staleReason } : {}),
    }));

  return serializeWorkspaceExport({
    workspace: { baseCurrency: workspace.baseCurrency, mode: workspace.mode },
    members: workspace.members,
    groups: workspace.groups,
    assets: assetRows.filter((row) => row.deletedAt === null).map(toExportedAsset),
    liabilities: liabilityRows
      .filter((row) => row.deletedAt === null)
      .map(toExportedLiability),
    operations,
    warningOverrides: warningOverrideRows.map((row) => ({
      code: row.code,
      entityId: row.entityId,
    })),
    fireConfig,
    snapshots: exportedSnapshots,
    trash: {
      assets: assetRows.filter((row) => row.deletedAt !== null).map(toExportedAsset),
      liabilities: liabilityRows
        .filter((row) => row.deletedAt !== null)
        .map(toExportedLiability),
    },
    priceCache,
  });
}

interface ExportHoldingDbRow {
  holdingId: string;
  kind: SnapshotHoldingKind;
  label: string;
  liquidityTier: LiquidityTier | null;
  snapshotId: string;
  unitPrice: string | null;
  units: string | null;
  valueMinor: number;
}

/**
 * Every frozen holding row grouped by its owning snapshot, in insertion
 * (rowid) order — the deterministic order the rows were captured in.
 */
function readHoldingRowsBySnapshot(
  sqlite: DatabaseConnection,
): Map<string, SnapshotHoldingRow[]> {
  const rows = sqlite
    .prepare(
      `
      SELECT
        snapshot_id AS snapshotId,
        holding_id AS holdingId,
        kind,
        label,
        liquidity_tier AS liquidityTier,
        value_minor AS valueMinor,
        units,
        unit_price AS unitPrice
      FROM snapshot_holdings
      ORDER BY rowid ASC
    `,
    )
    .all() as ExportHoldingDbRow[];

  const bySnapshot = new Map<string, SnapshotHoldingRow[]>();

  for (const row of rows) {
    const holding: SnapshotHoldingRow = {
      holdingId: row.holdingId,
      kind: row.kind,
      label: row.label,
      liquidityTier: row.liquidityTier,
      valueMinor: row.valueMinor,
      ...(row.units !== null ? { units: row.units } : {}),
      ...(row.unitPrice !== null ? { unitPrice: row.unitPrice } : {}),
    };
    const existing = bySnapshot.get(row.snapshotId);

    if (existing) {
      existing.push(holding);
    } else {
      bySnapshot.set(row.snapshotId, [holding]);
    }
  }

  return bySnapshot;
}

export function resolveDataDir(options: BootstrapHealthcheckOptions = {}): string {
  if (options.dataDir) {
    return resolve(options.dataDir);
  }

  if (process.env.WORTHLINE_DATA_DIR) {
    return resolve(process.env.WORTHLINE_DATA_DIR);
  }

  return join(findWorkspaceRoot(), ".local", "worthline");
}

function toDisplayPath(databasePath: string): string {
  const workspaceRoot = findWorkspaceRoot();
  const relativePath = relative(workspaceRoot, databasePath);

  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }

  return databasePath;
}

function findWorkspaceRoot(startAt = process.cwd()): string {
  let current = resolve(startAt);

  while (true) {
    const manifestPath = join(current, "package.json");

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        workspaces?: unknown;
      };

      if (manifest.workspaces) {
        return current;
      }
    }

    const parent = dirname(current);

    if (parent === current) {
      return resolve(startAt);
    }

    current = parent;
  }
}

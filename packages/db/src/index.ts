import type {
  DecimalString,
  LiquidityTier,
  LocalPersistenceStatus,
} from "@worthline/domain";
import type {
  AssetPrice,
  AssetType,
  CreateInvestmentOperationInput,
  CreateLiabilityInput,
  CreateManualAssetInput,
  DomainWarning,
  ExportedAsset,
  ExportedLiability,
  ExportedSnapshot,
  FireScopeConfig,
  InvestmentOperation,
  Liability,
  Member,
  MemberGroup,
  ManualAsset,
  NetWorthSnapshot,
  OwnershipShare,
  PositionSummary,
  SnapshotHoldingKind,
  SnapshotHoldingRow,
  WarningOverride,
  Workspace,
  WorkspaceExport,
  WorkspaceMode,
} from "@worthline/domain";
import {
  assertNotInvestmentAsset,
  assertSnapshotHoldingsReconcile,
  createInvestmentOperation,
  createLiability,
  createManualAsset,
  createWorkspace,
  deriveInvestmentValuation,
  derivePosition,
  selectInvestmentPrice,
  resolveScopeMemberIds,
  serializeWorkspaceExport,
} from "@worthline/domain";
import Database from "better-sqlite3";
import type { Database as DatabaseConnection } from "better-sqlite3";
import { and, asc, eq, isNull } from "drizzle-orm";
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
  snapshots,
  workspace as workspaceTable,
} from "./schema";
import { migrate } from "./migrate";

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

export interface SaveSnapshotInput {
  snapshot: NetWorthSnapshot;
  replace?: boolean;
  /**
   * The valued portfolio behind the snapshot's figures (ADR 0008) — saved
   * atomically with the snapshot row. Must reconcile exactly with the
   * snapshot's headline gross assets and debts or the save throws and
   * persists nothing.
   */
  holdings?: SnapshotHoldingRow[];
}

/** Filter for reading frozen holding rows: by scope and optional date-key window (inclusive). */
export interface SnapshotHoldingQuery {
  scopeId?: string;
  from?: string;
  to?: string;
}

/** A frozen holding row joined with its snapshot's identity and date. */
export interface SnapshotHoldingRecord extends SnapshotHoldingRow {
  snapshotId: string;
  scopeId: string;
  dateKey: string;
  capturedAt: string;
}

export interface CreateInvestmentAssetInput {
  id: string;
  name: string;
  currency: string;
  ownership: OwnershipShare[];
  liquidityTier?: LiquidityTier;
  unitSymbol?: string;
  isin?: string;
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
}

/** A derived position plus the asset name, for the dashboard positions table. */
export interface PositionView extends PositionSummary {
  name: string;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface InvestmentAssetMeta {
  id: string;
  name: string;
  currency: string;
  providerSymbol?: string;
}

/** Full investment asset record for edit/detail pages. */
export interface InvestmentAssetFull {
  id: string;
  name: string;
  currency: string;
  liquidityTier: LiquidityTier;
  ownership: OwnershipShare[];
  unitSymbol?: string;
  isin?: string;
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
}

export interface UpdateInvestmentAssetInput {
  id: string;
  name: string;
  unitSymbol?: string;
  isin?: string;
  manualPricePerUnit?: DecimalString;
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

/** Fields that can be changed when editing an existing manual asset. */
export interface UpdateAssetInput {
  name?: string;
  type?: ManualAsset["type"];
  liquidityTier?: LiquidityTier;
  isPrimaryResidence?: boolean;
  ownership?: OwnershipShare[];
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
  batchApplyAllValueUpdates: (assetCommands: ValueUpdateCommand[], liabilityCommands: ValueUpdateCommand[]) => void;
  reactivateMember: (memberId: string) => void;
  close: () => void;
  createInvestmentAsset: (input: CreateInvestmentAssetInput) => void;
  readInvestmentAssetById: (assetId: string) => InvestmentAssetFull | null;
  updateInvestmentAsset: (input: UpdateInvestmentAssetInput) => void;
  createLiability: (input: CreateLiabilityInput) => void;
  createManualAsset: (input: CreateManualAssetInput) => void;
  createMember: (member: Member) => void;
  deleteOperation: (operationId: string) => number;
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
  removeWarningOverride: (code: string, entityId: string) => void;
  restoreAsset: (assetId: string) => number;
  restoreLiability: (liabilityId: string) => number;
  saveFireConfig: (scopeId: string, config: FireScopeConfig) => void;
  saveSnapshot: (input: SaveSnapshotInput) => void;
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
  const writeAuditEntry = (
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown> = {},
  ): void => {
    sqlite
      .prepare(
        `INSERT INTO audit_log (id, action, entity_type, entity_id, details_json)
         VALUES (@id, @action, @entityType, @entityId, @detailsJson)`,
      )
      .run({
        action,
        detailsJson: JSON.stringify(details),
        entityId,
        entityType,
        id: randomUUID(),
      });
  };

  // Hard-delete one trashed asset in the caller's transaction. Captures the
  // entity's key data for the audit trail BEFORE destroying it; FK cascades
  // take ownerships, investment metadata, operations, and the price cache, and
  // we clear the warning overrides by hand (no FK points at them). Frozen
  // snapshot_holdings are intentionally never touched (ADR 0008): history stays
  // intact, so the holding keeps appearing in past captures. Returns the number
  // of asset rows removed (0 when the id is unknown or not in the trash).
  const hardDeleteAssetTx = (assetId: string): number => {
    const row = sqlite
      .prepare(
        `SELECT name, type, deleted_at AS deletedAt FROM assets WHERE id = ?`,
      )
      .get(assetId) as { name: string; type: string; deletedAt: string | null } | undefined;

    // Hard delete is reachable only from the trash: refuse a live holding.
    if (!row || row.deletedAt === null) {
      return 0;
    }

    const ownership = sqlite
      .prepare(
        `SELECT member_id AS memberId, share_bps AS shareBps FROM asset_ownerships WHERE asset_id = ?`,
      )
      .all(assetId);
    const operations =
      row.type === "investment"
        ? sqlite
            .prepare(
              `SELECT id, kind, executed_at AS executedAt, units, price_per_unit AS pricePerUnit, currency, fees_minor AS feesMinor
               FROM asset_operations WHERE asset_id = ?`,
            )
            .all(assetId)
        : [];

    sqlite.prepare(`DELETE FROM warning_overrides WHERE entity_id = ?`).run(assetId);
    const result = sqlite.prepare(`DELETE FROM assets WHERE id = ?`).run(assetId);

    writeAuditEntry("hard_delete_asset", "asset", assetId, {
      name: row.name,
      operations,
      ownership,
      type: row.type,
    });

    return result.changes;
  };

  // Hard-delete one trashed liability in the caller's transaction. FK cascade
  // takes its ownerships; snapshots stay frozen. Returns rows removed.
  const hardDeleteLiabilityTx = (liabilityId: string): number => {
    const row = sqlite
      .prepare(
        `SELECT name, type, deleted_at AS deletedAt FROM liabilities WHERE id = ?`,
      )
      .get(liabilityId) as { name: string; type: string; deletedAt: string | null } | undefined;

    if (!row || row.deletedAt === null) {
      return 0;
    }

    const ownership = sqlite
      .prepare(
        `SELECT member_id AS memberId, share_bps AS shareBps FROM liability_ownerships WHERE liability_id = ?`,
      )
      .all(liabilityId);

    sqlite.prepare(`DELETE FROM warning_overrides WHERE entity_id = ?`).run(liabilityId);
    const result = sqlite.prepare(`DELETE FROM liabilities WHERE id = ?`).run(liabilityId);

    writeAuditEntry("hard_delete_liability", "liability", liabilityId, {
      name: row.name,
      ownership,
      type: row.type,
    });

    return result.changes;
  };

  // Per-unit-of-work workspace cache. readWorkspace, readAssets, and
  // readLiabilities all need the workspace, but it only changes on membership
  // writes — so cache it for the store's (short) lifetime and invalidate on
  // those writes. A single page render then reads it once instead of three times.
  let cachedWorkspace: Workspace | null | undefined;
  const getWorkspace = (): Workspace | null => {
    if (cachedWorkspace === undefined) {
      cachedWorkspace = readWorkspace(sqlite);
    }

    return cachedWorkspace;
  };
  const invalidateWorkspace = (): void => {
    cachedWorkspace = undefined;
  };

  return {
    close: () => {
      sqlite.close();
    },
    readInvestmentAssetById: (assetId) => {
      const db = drizzle(sqlite);
      const row = db
        .select({
          id: assets.id,
          name: assets.name,
          currency: assets.currency,
          liquidityTier: assets.liquidityTier,
        })
        .from(assets)
        .where(eq(assets.id, assetId))
        .get();

      if (!row) return null;

      const investRow = db
        .select({
          unitSymbol: investmentAssets.unitSymbol,
          isin: investmentAssets.isin,
          providerSymbol: investmentAssets.providerSymbol,
          manualPricePerUnit: investmentAssets.manualPricePerUnit,
        })
        .from(investmentAssets)
        .where(eq(investmentAssets.assetId, assetId))
        .get();

      if (!investRow) return null;

      const ownershipRows = db
        .select({ memberId: assetOwnerships.memberId, shareBps: assetOwnerships.shareBps })
        .from(assetOwnerships)
        .where(eq(assetOwnerships.assetId, assetId))
        .orderBy(asc(assetOwnerships.memberId))
        .all();

      return {
        id: row.id,
        name: row.name,
        currency: row.currency,
        liquidityTier: row.liquidityTier,
        ownership: ownershipRows,
        ...(investRow.unitSymbol ? { unitSymbol: investRow.unitSymbol } : {}),
        ...(investRow.isin ? { isin: investRow.isin } : {}),
        ...(investRow.providerSymbol ? { providerSymbol: investRow.providerSymbol } : {}),
        ...(investRow.manualPricePerUnit
          ? { manualPricePerUnit: investRow.manualPricePerUnit }
          : {}),
      };
    },
    updateInvestmentAsset: (input) => {
      const update = sqlite.transaction(() => {
        sqlite
          .prepare(
            `UPDATE assets SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          )
          .run(input.name, input.id);

        sqlite
          .prepare(
            `UPDATE investment_assets
             SET unit_symbol = ?, isin = ?, manual_price_per_unit = ?
             WHERE asset_id = ?`,
          )
          .run(
            input.unitSymbol ?? null,
            input.isin ?? null,
            input.manualPricePerUnit ?? null,
            input.id,
          );
      });

      update();
      writeAuditEntry("update_investment_asset", "asset", input.id, {
        name: input.name,
      });
    },
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
    createManualAsset: (input) => {
      const workspace = getWorkspace();

      if (!workspace) {
        throw new Error("Workspace must be initialized before creating assets.");
      }

      const asset = createManualAsset(workspace, input);
      const insert = sqlite.transaction(() => {
        sqlite
          .prepare(
            `
            INSERT INTO assets (
              id,
              name,
              type,
              currency,
              current_value_minor,
              liquidity_tier,
              is_primary_residence
            )
            VALUES (
              @id,
              @name,
              @type,
              @currency,
              @currentValueMinor,
              @liquidityTier,
              @isPrimaryResidence
            )
          `,
          )
          .run({
            currency: asset.currency,
            currentValueMinor: asset.currentValue.amountMinor,
            id: asset.id,
            isPrimaryResidence: asset.isPrimaryResidence ? 1 : 0,
            liquidityTier: asset.liquidityTier,
            name: asset.name,
            type: asset.type,
          });

        const insertOwnership = sqlite.prepare(`
          INSERT INTO asset_ownerships (asset_id, member_id, share_bps)
          VALUES (@assetId, @memberId, @shareBps)
        `);

        for (const share of asset.ownership) {
          insertOwnership.run({
            assetId: asset.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          });
        }
      });

      insert();
      writeAuditEntry("create_asset", "asset", asset.id);
    },
    createInvestmentAsset: (input) => {
      const workspace = getWorkspace();

      if (!workspace) {
        throw new Error("Workspace must be initialized before creating assets.");
      }

      // Reuse the manual-asset constructor for ownership/currency validation. A
      // unit-based asset starts at zero value; its real value is derived from
      // operations + price on read.
      const asset = createManualAsset(workspace, {
        currency: input.currency,
        currentValueMinor: 0,
        id: input.id,
        isPrimaryResidence: false,
        liquidityTier: input.liquidityTier ?? "market",
        name: input.name,
        ownership: input.ownership,
        type: "investment",
      });
      const pricedAt = input.manualPricePerUnit ? new Date().toISOString() : null;

      const insert = sqlite.transaction(() => {
        sqlite
          .prepare(
            `
            INSERT INTO assets (
              id,
              name,
              type,
              currency,
              current_value_minor,
              liquidity_tier,
              is_primary_residence
            )
            VALUES (
              @id,
              @name,
              @type,
              @currency,
              @currentValueMinor,
              @liquidityTier,
              @isPrimaryResidence
            )
          `,
          )
          .run({
            currency: asset.currency,
            currentValueMinor: 0,
            id: asset.id,
            isPrimaryResidence: 0,
            liquidityTier: asset.liquidityTier,
            name: asset.name,
            type: asset.type,
          });

        const insertOwnership = sqlite.prepare(`
          INSERT INTO asset_ownerships (asset_id, member_id, share_bps)
          VALUES (@assetId, @memberId, @shareBps)
        `);

        for (const share of asset.ownership) {
          insertOwnership.run({
            assetId: asset.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          });
        }

        sqlite
          .prepare(
            `
            INSERT INTO investment_assets (
              asset_id,
              unit_symbol,
              isin,
              provider_symbol,
              manual_price_per_unit,
              manual_priced_at
            )
            VALUES (
              @assetId,
              @unitSymbol,
              @isin,
              @providerSymbol,
              @manualPricePerUnit,
              @manualPricedAt
            )
          `,
          )
          .run({
            assetId: asset.id,
            isin: input.isin ?? null,
            manualPricePerUnit: input.manualPricePerUnit ?? null,
            manualPricedAt: pricedAt,
            providerSymbol: input.providerSymbol ?? null,
            unitSymbol: input.unitSymbol ?? null,
          });
      });

      insert();
    },
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
    readAssets: () => readAssets(sqlite, getWorkspace()),
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
    readPositions: (scopeId) => readPositions(sqlite, getWorkspace(), scopeId),
    readSnapshots: (scopeId) => readSnapshots(sqlite, scopeId),
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
    saveSnapshot: (input) => {
      const snapshot = input.snapshot;

      // Reconciliation invariant (ADR 0008): verify before ANY write so a
      // capture whose rows contradict its own figures persists nothing.
      if (input.holdings) {
        assertSnapshotHoldingsReconcile(input.holdings, {
          debtsMinor: snapshot.debts.amountMinor,
          grossAssetsMinor: snapshot.grossAssets.amountMinor,
        });
      }

      const save = sqlite.transaction(() => {
        if (snapshot.isMonthlyClose) {
          sqlite
            .prepare(
              `
              UPDATE snapshots
              SET is_monthly_close = 0
              WHERE scope_id = ? AND month_key = ?
            `,
            )
            .run(snapshot.scopeId, snapshot.monthKey);
        }

        // Upsert on (scope_id, date_key): concurrent first-loads degrade
        // gracefully — the second write updates rather than throwing.
        // explicit replace flag keeps the old id-based delete path for callers
        // that need to force a specific snapshot id.
        //
        // Either way the same-day snapshot is superseded, so its holding rows
        // go with it — at most one set of rows per scope per day. The delete
        // must run before the upsert because the upsert rewrites the parent
        // snapshot id that the rows' foreign key points at.
        const existing = sqlite
          .prepare(`SELECT id FROM snapshots WHERE scope_id = ? AND date_key = ?`)
          .get(snapshot.scopeId, snapshot.dateKey) as { id: string } | undefined;

        if (existing) {
          sqlite
            .prepare(`DELETE FROM snapshot_holdings WHERE snapshot_id = ?`)
            .run(existing.id);

          if (input.replace) {
            sqlite.prepare("DELETE FROM snapshots WHERE id = ?").run(existing.id);
          }
        }

        sqlite
          .prepare(
            `
            INSERT INTO snapshots (
              id,
              scope_id,
              scope_label,
              captured_at,
              date_key,
              month_key,
              is_monthly_close,
              currency,
              total_net_worth_minor,
              liquid_net_worth_minor,
              housing_equity_minor,
              gross_assets_minor,
              debts_minor,
              warnings_json
            )
            VALUES (
              @id,
              @scopeId,
              @scopeLabel,
              @capturedAt,
              @dateKey,
              @monthKey,
              @isMonthlyClose,
              @currency,
              @totalNetWorthMinor,
              @liquidNetWorthMinor,
              @housingEquityMinor,
              @grossAssetsMinor,
              @debtsMinor,
              @warningsJson
            )
            ON CONFLICT(scope_id, date_key) DO UPDATE SET
              id = excluded.id,
              scope_label = excluded.scope_label,
              captured_at = excluded.captured_at,
              month_key = excluded.month_key,
              is_monthly_close = excluded.is_monthly_close,
              currency = excluded.currency,
              total_net_worth_minor = excluded.total_net_worth_minor,
              liquid_net_worth_minor = excluded.liquid_net_worth_minor,
              housing_equity_minor = excluded.housing_equity_minor,
              gross_assets_minor = excluded.gross_assets_minor,
              debts_minor = excluded.debts_minor,
              warnings_json = excluded.warnings_json
          `,
          )
          .run({
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

        if (input.holdings && input.holdings.length > 0) {
          const insertHolding = sqlite.prepare(`
            INSERT INTO snapshot_holdings (
              id,
              snapshot_id,
              holding_id,
              kind,
              label,
              liquidity_tier,
              value_minor,
              units,
              unit_price
            )
            VALUES (
              @id,
              @snapshotId,
              @holdingId,
              @kind,
              @label,
              @liquidityTier,
              @valueMinor,
              @units,
              @unitPrice
            )
          `);

          for (const row of input.holdings) {
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
      });

      save();
    },
    readSnapshotHoldings: (query) => readSnapshotHoldings(sqlite, query),
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
    updateAsset: (assetId, input) => {
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

      if (input.liquidityTier !== undefined) {
        updates.push("liquidity_tier = ?");
        params.push(input.liquidityTier);
      }

      if (input.isPrimaryResidence !== undefined) {
        updates.push("is_primary_residence = ?");
        params.push(input.isPrimaryResidence ? 1 : 0);
      }

      const editAsset = sqlite.transaction(() => {
        if (updates.length > 0) {
          updates.push("updated_at = CURRENT_TIMESTAMP");
          params.push(assetId);
          sqlite
            .prepare(`UPDATE assets SET ${updates.join(", ")} WHERE id = ?`)
            .run(...params);
        }

        if (input.ownership !== undefined) {
          sqlite
            .prepare(`DELETE FROM asset_ownerships WHERE asset_id = ?`)
            .run(assetId);

          const insertOwnership = sqlite.prepare(`
            INSERT INTO asset_ownerships (asset_id, member_id, share_bps)
            VALUES (@assetId, @memberId, @shareBps)
          `);

          for (const share of input.ownership) {
            insertOwnership.run({
              assetId,
              memberId: share.memberId,
              shareBps: share.shareBps,
            });
          }
        }
      });

      editAsset();
      writeAuditEntry("update_asset", "asset", assetId, { ...input, ownership: undefined });
    },
    updateAssetValuation: (assetId, currentValueMinor) => {
      if (!Number.isInteger(currentValueMinor)) {
        throw new Error("Money must be stored as integer minor units.");
      }

      // Domain guard: investment assets have a derived value (units × price)
      // and must never be valued by hand (ADR 0006).
      const assetRow = sqlite
        .prepare(`SELECT type FROM assets WHERE id = ?`)
        .get(assetId) as { type: string } | undefined;

      if (assetRow) {
        assertNotInvestmentAsset({
          id: assetId,
          type: assetRow.type as AssetType,
          name: assetId,
          currency: "EUR",
          currentValue: { amountMinor: 0, currency: "EUR" },
          liquidityTier: "market",
          ownership: [],
          isPrimaryResidence: false,
        });
      }

      sqlite
        .prepare(
          `
          UPDATE assets
          SET current_value_minor = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        )
        .run(currentValueMinor, assetId);
      writeAuditEntry("update_valuation", "asset", assetId, { currentValueMinor });
    },
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
    readInvestmentAssetsWithMeta: () => {
      const db = drizzle(sqlite);
      const rows = db
        .select({
          id: assets.id,
          name: assets.name,
          currency: assets.currency,
          providerSymbol: investmentAssets.providerSymbol,
        })
        .from(assets)
        .innerJoin(investmentAssets, eq(investmentAssets.assetId, assets.id))
        .where(isNull(assets.deletedAt))
        .orderBy(asc(assets.createdAt), asc(assets.id))
        .all();

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        currency: row.currency,
        ...(row.providerSymbol ? { providerSymbol: row.providerSymbol } : {}),
      }));
    },
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
    softDeleteAsset: (assetId, deletedAt) => {
      const result = sqlite
        .prepare(`UPDATE assets SET deleted_at = ? WHERE id = ?`)
        .run(deletedAt, assetId);
      if (result.changes > 0) {
        writeAuditEntry("delete_asset", "asset", assetId, { deletedAt });
      }
      return result.changes;
    },
    restoreAsset: (assetId) => {
      const result = sqlite
        .prepare(
          `UPDATE assets SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`,
        )
        .run(assetId);
      if (result.changes > 0) {
        writeAuditEntry("restore_asset", "asset", assetId);
      }
      return result.changes;
    },
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
        .prepare(
          `SELECT id, name FROM assets WHERE deleted_at IS NOT NULL ORDER BY name`,
        )
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
    hardDeleteAsset: (assetId) =>
      sqlite.transaction(() => hardDeleteAssetTx(assetId))(),
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
        for (const row of trashedAssets) assets += hardDeleteAssetTx(row.id);
        for (const row of trashedLiabilities) liabilities += hardDeleteLiabilityTx(row.id);

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
        return 0;
      }

      const result = sqlite
        .prepare(`DELETE FROM asset_operations WHERE id = ?`)
        .run(operationId);

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

      return result.changes;
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
            asset_id, unit_symbol, isin, provider_symbol,
            manual_price_per_unit, manual_priced_at
          )
          VALUES (
            @assetId, @unitSymbol, @isin, @providerSymbol,
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
              asset.type === "investment"
                ? 0
                : (asset.currentValue?.amountMinor ?? 0),
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
  };
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

function readAssets(
  sqlite: DatabaseConnection,
  workspace: Workspace | null,
): ManualAsset[] {
  if (!workspace) {
    return [];
  }

  const rows = drizzle(sqlite)
    .select({
      currency: assets.currency,
      currentValueMinor: assets.currentValueMinor,
      id: assets.id,
      isPrimaryResidence: assets.isPrimaryResidence,
      liquidityTier: assets.liquidityTier,
      name: assets.name,
      type: assets.type,
    })
    .from(assets)
    .where(isNull(assets.deletedAt))
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();
  const ownershipByAsset = readAssetOwnerships(sqlite);
  const hasInvestments = rows.some((row) => row.type === "investment");
  const operationsByAsset = hasInvestments
    ? readAllOperations(sqlite)
    : new Map<string, InvestmentOperation[]>();
  const metaByAsset = hasInvestments
    ? readInvestmentMeta(sqlite)
    : new Map<string, InvestmentMeta>();
  const priceCacheByAsset = hasInvestments
    ? readAllPriceCache(sqlite)
    : new Map<string, { price: string }>();

  return rows.map((row) =>
    createManualAsset(workspace, {
      currency: row.currency,
      currentValueMinor:
        row.type === "investment"
          ? investmentValueMinor(
              row.id,
              row.currency,
              operationsByAsset,
              metaByAsset,
              priceCacheByAsset,
            )
          : row.currentValueMinor,
      id: row.id,
      isPrimaryResidence: row.isPrimaryResidence === 1,
      liquidityTier: row.liquidityTier,
      name: row.name,
      ownership: ownershipByAsset.get(row.id) ?? [],
      type: row.type,
    }),
  );
}

interface InvestmentMeta {
  manualPricePerUnit?: DecimalString;
}

/** The derived current value of an investment asset: market value if a price is
 *  known, otherwise its remaining cost basis (book value). */
function investmentValueMinor(
  assetId: string,
  currency: string,
  operationsByAsset: Map<string, InvestmentOperation[]>,
  metaByAsset: Map<string, InvestmentMeta>,
  priceCacheByAsset: Map<string, { price: string }>,
): number {
  return deriveInvestmentValuation({
    assetId,
    cachedPrice: priceCacheByAsset.get(assetId)?.price,
    currency,
    manualPrice: metaByAsset.get(assetId)?.manualPricePerUnit,
    operations: operationsByAsset.get(assetId) ?? [],
  }).valueMinor;
}

function readAllOperations(
  sqlite: DatabaseConnection,
): Map<string, InvestmentOperation[]> {
  const rows = drizzle(sqlite)
    .select()
    .from(assetOperations)
    .orderBy(asc(assetOperations.executedAt), asc(assetOperations.id))
    .all();

  return rows.reduce((byAsset, row) => {
    const operation = toOperation(row);
    const existing = byAsset.get(row.assetId);

    if (existing) {
      existing.push(operation);
    } else {
      byAsset.set(row.assetId, [operation]);
    }

    return byAsset;
  }, new Map<string, InvestmentOperation[]>());
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

function toOperation(row: typeof assetOperations.$inferSelect): InvestmentOperation {
  return {
    assetId: row.assetId,
    currency: row.currency,
    executedAt: row.executedAt,
    feesMinor: row.feesMinor,
    id: row.id,
    kind: row.kind,
    pricePerUnit: row.pricePerUnit,
    units: row.units,
  };
}

function readInvestmentMeta(sqlite: DatabaseConnection): Map<string, InvestmentMeta> {
  const rows = drizzle(sqlite)
    .select({
      assetId: investmentAssets.assetId,
      manualPricePerUnit: investmentAssets.manualPricePerUnit,
    })
    .from(investmentAssets)
    .all();

  return rows.reduce((byAsset, row) => {
    byAsset.set(
      row.assetId,
      row.manualPricePerUnit ? { manualPricePerUnit: row.manualPricePerUnit } : {},
    );

    return byAsset;
  }, new Map<string, InvestmentMeta>());
}

function readPositions(
  sqlite: DatabaseConnection,
  workspace: Workspace | null,
  scopeId?: string,
): PositionView[] {
  if (!workspace) {
    return [];
  }

  const rows = drizzle(sqlite)
    .select({ currency: assets.currency, id: assets.id, name: assets.name })
    .from(assets)
    .where(and(eq(assets.type, "investment"), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();

  if (rows.length === 0) {
    return [];
  }

  const ownershipByAsset = readAssetOwnerships(sqlite);
  const operationsByAsset = readAllOperations(sqlite);
  const metaByAsset = readInvestmentMeta(sqlite);
  const priceCacheByAsset = readAllPriceCache(sqlite);
  const scopeMemberIds = scopeId
    ? new Set(resolveScopeMemberIds(workspace, scopeId))
    : null;

  const views: PositionView[] = [];

  for (const row of rows) {
    const ownership = ownershipByAsset.get(row.id) ?? [];

    if (
      scopeMemberIds &&
      !ownership.some((share) => scopeMemberIds.has(share.memberId))
    ) {
      continue;
    }

    // Price-selection rule is owned by selectInvestmentPrice (ADR 0006).
    // We need the full PositionSummary for the positions table view, so we call
    // derivePosition with the price that selectInvestmentPrice picks.
    const selected = selectInvestmentPrice({
      cachedPrice: priceCacheByAsset.get(row.id)?.price,
      manualPrice: metaByAsset.get(row.id)?.manualPricePerUnit,
    });
    const position = derivePosition(operationsByAsset.get(row.id) ?? [], {
      assetId: row.id,
      currency: row.currency,
      ...(selected ? { currentPricePerUnit: selected.pricePerUnit } : {}),
    });

    views.push({ ...position, name: row.name });
  }

  return views;
}

function readAllPriceCache(sqlite: DatabaseConnection): Map<string, { price: string }> {
  const rows = drizzle(sqlite).select().from(assetPriceCache).all();

  return rows.reduce((map, row) => {
    map.set(row.assetId, { price: row.price });
    return map;
  }, new Map<string, { price: string }>());
}

/** All asset ownership rows in one query, grouped by asset id (member order preserved). */
function readAssetOwnerships(sqlite: DatabaseConnection): Map<string, OwnershipShare[]> {
  const rows = drizzle(sqlite)
    .select({
      assetId: assetOwnerships.assetId,
      memberId: assetOwnerships.memberId,
      shareBps: assetOwnerships.shareBps,
    })
    .from(assetOwnerships)
    .orderBy(asc(assetOwnerships.assetId), asc(assetOwnerships.memberId))
    .all();

  return groupOwnershipByOwner(rows, (row) => row.assetId);
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

/** Group flat ownership rows into a map keyed by their owning entity id. */
function groupOwnershipByOwner<Row extends { memberId: string; shareBps: number }>(
  rows: Row[],
  ownerIdOf: (row: Row) => string,
): Map<string, OwnershipShare[]> {
  const byOwner = new Map<string, OwnershipShare[]>();

  for (const row of rows) {
    const ownerId = ownerIdOf(row);
    const share: OwnershipShare = { memberId: row.memberId, shareBps: row.shareBps };
    const existing = byOwner.get(ownerId);

    if (existing) {
      existing.push(share);
    } else {
      byOwner.set(ownerId, [share]);
    }
  }

  return byOwner;
}

function readSnapshots(sqlite: DatabaseConnection, scopeId?: string): NetWorthSnapshot[] {
  const db = drizzle(sqlite);
  const rows = scopeId
    ? db
        .select()
        .from(snapshots)
        .where(eq(snapshots.scopeId, scopeId))
        .orderBy(asc(snapshots.capturedAt), asc(snapshots.id))
        .all()
    : db
        .select()
        .from(snapshots)
        .orderBy(asc(snapshots.capturedAt), asc(snapshots.id))
        .all();

  return rows.map((row) => ({
    capturedAt: row.capturedAt,
    dateKey: row.dateKey,
    debts: { amountMinor: row.debtsMinor, currency: row.currency },
    grossAssets: { amountMinor: row.grossAssetsMinor, currency: row.currency },
    housingEquity: { amountMinor: row.housingEquityMinor, currency: row.currency },
    id: row.id,
    isMonthlyClose: row.isMonthlyClose === 1,
    liquidNetWorth: { amountMinor: row.liquidNetWorthMinor, currency: row.currency },
    monthKey: row.monthKey,
    scopeId: row.scopeId,
    scopeLabel: row.scopeLabel,
    totalNetWorth: { amountMinor: row.totalNetWorthMinor, currency: row.currency },
    warnings: JSON.parse(row.warningsJson) as DomainWarning[],
  }));
}

interface SnapshotHoldingDbRow {
  capturedAt: string;
  dateKey: string;
  holdingId: string;
  kind: SnapshotHoldingKind;
  label: string;
  liquidityTier: LiquidityTier | null;
  scopeId: string;
  snapshotId: string;
  unitPrice: string | null;
  units: string | null;
  valueMinor: number;
}

/**
 * Read frozen holding rows (ADR 0008), optionally filtered by scope and by an
 * inclusive date-key window. Rows are joined with their snapshot for identity
 * and ordering — chronological, then assets before liabilities, then by the
 * frozen label for a stable presentation order.
 */
function readSnapshotHoldings(
  sqlite: DatabaseConnection,
  query: SnapshotHoldingQuery = {},
): SnapshotHoldingRecord[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.scopeId !== undefined) {
    conditions.push("s.scope_id = ?");
    params.push(query.scopeId);
  }

  if (query.from !== undefined) {
    conditions.push("s.date_key >= ?");
    params.push(query.from);
  }

  if (query.to !== undefined) {
    conditions.push("s.date_key <= ?");
    params.push(query.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = sqlite
    .prepare(
      `
      SELECT
        h.snapshot_id AS snapshotId,
        s.scope_id AS scopeId,
        s.date_key AS dateKey,
        s.captured_at AS capturedAt,
        h.holding_id AS holdingId,
        h.kind AS kind,
        h.label AS label,
        h.liquidity_tier AS liquidityTier,
        h.value_minor AS valueMinor,
        h.units AS units,
        h.unit_price AS unitPrice
      FROM snapshot_holdings h
      JOIN snapshots s ON s.id = h.snapshot_id
      ${where}
      ORDER BY s.date_key ASC, s.scope_id ASC, h.kind ASC, h.label ASC, h.holding_id ASC
    `,
    )
    .all(...params) as SnapshotHoldingDbRow[];

  return rows.map((row) => ({
    capturedAt: row.capturedAt,
    dateKey: row.dateKey,
    holdingId: row.holdingId,
    kind: row.kind,
    label: row.label,
    liquidityTier: row.liquidityTier,
    scopeId: row.scopeId,
    snapshotId: row.snapshotId,
    valueMinor: row.valueMinor,
    ...(row.units !== null ? { units: row.units } : {}),
    ...(row.unitPrice !== null ? { unitPrice: row.unitPrice } : {}),
  }));
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
        : { currentValue: { amountMinor: row.currentValueMinor, currency: row.currency } }),
      liquidityTier: row.liquidityTier,
      isPrimaryResidence: row.isPrimaryResidence === 1,
      ownership: ownershipByAsset.get(row.id) ?? [],
      ...(row.type === "investment" && meta
        ? {
            investment: {
              ...(meta.unitSymbol ? { unitSymbol: meta.unitSymbol } : {}),
              ...(meta.isin ? { isin: meta.isin } : {}),
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
  const exportedSnapshots: ExportedSnapshot[] = readSnapshots(sqlite).map(
    (snapshot) => ({
      ...snapshot,
      holdings: holdingsBySnapshot.get(snapshot.id) ?? [],
    }),
  );

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

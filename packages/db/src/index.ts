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
  FireScopeConfig,
  InvestmentOperation,
  Liability,
  Member,
  MemberGroup,
  ManualAsset,
  NetWorthSnapshot,
  OwnershipShare,
  PositionSummary,
  WarningOverride,
  Workspace,
  WorkspaceMode,
} from "@worthline/domain";
import {
  assertNotInvestmentAsset,
  createInvestmentOperation,
  createLiability,
  createManualAsset,
  createWorkspace,
  deriveInvestmentValuation,
  derivePosition,
  selectInvestmentPrice,
  resolveScopeMemberIds,
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
  snapshots,
  workspace as workspaceTable,
} from "./schema";
import { migrate } from "./migrate";

const bootstrapKey = "bootstrap.last_healthcheck_at";

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
  disableMember: (memberId: string, disabledAt: string) => void;
  initializeWorkspace: (input: InitializeWorkspaceInput) => void;
  readAllPriceCacheEntries: () => AssetPrice[];
  readAssets: () => ManualAsset[];
  readInvestmentAssetsWithMeta: () => InvestmentAssetMeta[];
  readAuditLog: (filter?: { entityId?: string }) => AuditLogEntry[];
  readFireConfig: () => Record<string, FireScopeConfig>;
  readLiabilities: () => Liability[];
  readOperations: (assetId: string) => InvestmentOperation[];
  readPositions: (scopeId?: string) => PositionView[];
  readPriceCache: (assetId: string) => AssetPrice | null;
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
        if (input.replace) {
          const existing = sqlite
            .prepare(`SELECT id FROM snapshots WHERE scope_id = ? AND date_key = ?`)
            .get(snapshot.scopeId, snapshot.dateKey) as { id: string } | undefined;

          if (existing) {
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
      });

      save();
    },
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
        .prepare(`UPDATE assets SET deleted_at = NULL WHERE id = ?`)
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
        .prepare(`UPDATE liabilities SET deleted_at = NULL WHERE id = ?`)
        .run(liabilityId);
      if (result.changes > 0) {
        writeAuditEntry("restore_liability", "liability", liabilityId);
      }
      return result.changes;
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
    .where(eq(assets.type, "investment"))
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

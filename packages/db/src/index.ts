import type { LocalPersistenceStatus } from "@worthline/contracts";
import type {
  CreateLiabilityInput,
  CreateManualAssetInput,
  CreateNetWorthSnapshotInput,
  Liability,
  Member,
  MemberGroup,
  ManualAsset,
  NetWorthSnapshot,
  Workspace,
  WorkspaceMode,
} from "@worthline/domain";
import {
  createLiability,
  createManualAsset,
  createNetWorthSnapshot,
  createWorkspace,
} from "@worthline/domain";
import Database from "better-sqlite3";
import type { Database as DatabaseConnection } from "better-sqlite3";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  appSettings,
  assetOwnerships,
  assets,
  liabilities,
  liabilityOwnerships,
  memberGroupMembers,
  memberGroups,
  members,
  snapshots,
  workspace as workspaceTable,
} from "./schema";
import { schemaSql } from "./schema-sql";

const SCHEMA_VERSION = 1;

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

export interface SaveSnapshotInput extends CreateNetWorthSnapshotInput {
  replace?: boolean;
}

export interface WorthlineStore {
  close: () => void;
  createLiability: (input: CreateLiabilityInput) => void;
  createManualAsset: (input: CreateManualAssetInput) => void;
  createMember: (member: Member) => void;
  disableMember: (memberId: string, disabledAt: string) => void;
  initializeWorkspace: (input: InitializeWorkspaceInput) => void;
  readAssets: () => ManualAsset[];
  readLiabilities: () => Liability[];
  readSnapshots: (scopeId?: string) => NetWorthSnapshot[];
  readWorkspace: () => Workspace | null;
  saveSnapshot: (input: SaveSnapshotInput) => void;
  updateAssetValuation: (assetId: string, currentValueMinor: number) => void;
  updateLiabilityBalance: (liabilityId: string, balanceMinor: number) => void;
  updateMember: (member: Pick<Member, "id" | "name">) => void;
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

export function createWorthlineStore(
  options: WorthlineStoreOptions = {},
): WorthlineStore {
  const databasePath = resolveDatabasePath(options);
  mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);
  migrate(sqlite);

  return {
    close: () => {
      sqlite.close();
    },
    createLiability: (input) => {
      const workspace = readWorkspace(sqlite);

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
    },
    createManualAsset: (input) => {
      const workspace = readWorkspace(sqlite);

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
    },
    readAssets: () => readAssets(sqlite),
    readLiabilities: () => readLiabilities(sqlite),
    readSnapshots: (scopeId) => readSnapshots(sqlite, scopeId),
    readWorkspace: () => readWorkspace(sqlite),
    saveSnapshot: (input) => {
      const snapshot = createNetWorthSnapshot(input);
      const existing = sqlite
        .prepare(
          `
          SELECT id
          FROM snapshots
          WHERE scope_id = ? AND date_key = ?
        `,
        )
        .get(snapshot.scopeId, snapshot.dateKey) as { id: string } | undefined;

      if (existing && existing.id !== snapshot.id && !input.replace) {
        throw new Error(
          `Snapshot already exists for ${snapshot.scopeId} on ${snapshot.dateKey}.`,
        );
      }

      const save = sqlite.transaction(() => {
        if (existing && input.replace) {
          sqlite.prepare("DELETE FROM snapshots WHERE id = ?").run(existing.id);
        }

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
    updateAssetValuation: (assetId, currentValueMinor) => {
      if (!Number.isInteger(currentValueMinor)) {
        throw new Error("Money must be stored as integer minor units.");
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

function migrate(sqlite: DatabaseConnection): void {
  // Connection-level pragmas must be set outside any transaction. The schema is
  // the single source of truth: schemaSql is generated from src/schema.ts via
  // `npm run db:generate`. user_version makes this idempotent across reopens.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const version = sqlite.pragma("user_version", { simple: true }) as number;

  if (version >= SCHEMA_VERSION) {
    return;
  }

  sqlite.exec(schemaSql);
  sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
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
    mode: workspaceRow.mode as WorkspaceMode,
  });
}

function readAssets(sqlite: DatabaseConnection): ManualAsset[] {
  const workspace = readWorkspace(sqlite);

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
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();

  return rows.map((row) =>
    createManualAsset(workspace, {
      currency: row.currency,
      currentValueMinor: row.currentValueMinor,
      id: row.id,
      isPrimaryResidence: row.isPrimaryResidence === 1,
      liquidityTier: row.liquidityTier as CreateManualAssetInput["liquidityTier"],
      name: row.name,
      ownership: readAssetOwnership(sqlite, row.id),
      type: row.type as CreateManualAssetInput["type"],
    }),
  );
}

function readAssetOwnership(
  sqlite: DatabaseConnection,
  assetId: string,
): CreateManualAssetInput["ownership"] {
  return drizzle(sqlite)
    .select({ memberId: assetOwnerships.memberId, shareBps: assetOwnerships.shareBps })
    .from(assetOwnerships)
    .where(eq(assetOwnerships.assetId, assetId))
    .orderBy(asc(assetOwnerships.memberId))
    .all();
}

function readLiabilities(sqlite: DatabaseConnection): Liability[] {
  const workspace = readWorkspace(sqlite);

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
    .orderBy(asc(liabilities.createdAt), asc(liabilities.id))
    .all();

  return rows.map((row) =>
    createLiability(workspace, {
      balanceMinor: row.balanceMinor,
      currency: row.currency,
      id: row.id,
      name: row.name,
      ownership: readLiabilityOwnership(sqlite, row.id),
      type: row.type as CreateLiabilityInput["type"],
      ...(row.associatedAssetId ? { associatedAssetId: row.associatedAssetId } : {}),
    }),
  );
}

function readLiabilityOwnership(
  sqlite: DatabaseConnection,
  liabilityId: string,
): CreateLiabilityInput["ownership"] {
  return drizzle(sqlite)
    .select({
      memberId: liabilityOwnerships.memberId,
      shareBps: liabilityOwnerships.shareBps,
    })
    .from(liabilityOwnerships)
    .where(eq(liabilityOwnerships.liabilityId, liabilityId))
    .orderBy(asc(liabilityOwnerships.memberId))
    .all();
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
    warnings: JSON.parse(row.warningsJson) as string[],
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

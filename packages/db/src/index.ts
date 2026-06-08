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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { appSettings } from "./schema";

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
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS workspace (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      mode TEXT NOT NULL CHECK (mode IN ('individual', 'household')),
      base_currency TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      disabled_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS member_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS member_group_members (
      group_id TEXT NOT NULL REFERENCES member_groups(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (group_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      currency TEXT NOT NULL,
      current_value_minor INTEGER NOT NULL,
      liquidity_tier TEXT NOT NULL,
      is_primary_residence INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS asset_ownerships (
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
      share_bps INTEGER NOT NULL,
      PRIMARY KEY (asset_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS liabilities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      currency TEXT NOT NULL,
      current_balance_minor INTEGER NOT NULL,
      associated_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS liability_ownerships (
      liability_id TEXT NOT NULL REFERENCES liabilities(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
      share_bps INTEGER NOT NULL,
      PRIMARY KEY (liability_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      scope_label TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      date_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      is_monthly_close INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL,
      total_net_worth_minor INTEGER NOT NULL,
      liquid_net_worth_minor INTEGER NOT NULL,
      housing_equity_minor INTEGER NOT NULL,
      gross_assets_minor INTEGER NOT NULL,
      debts_minor INTEGER NOT NULL,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS snapshots_scope_date_unique
      ON snapshots(scope_id, date_key);
  `);
}

function readWorkspace(sqlite: DatabaseConnection): Workspace | null {
  const workspaceRow = sqlite
    .prepare(
      "SELECT mode, base_currency AS baseCurrency FROM workspace WHERE id = 'default'",
    )
    .get() as { baseCurrency: string; mode: WorkspaceMode } | undefined;

  if (!workspaceRow) {
    return null;
  }

  const members = sqlite
    .prepare(
      `
      SELECT id, name, disabled_at AS disabledAt
      FROM members
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all() as Array<{ disabledAt: string | null; id: string; name: string }>;

  const groupRows = sqlite
    .prepare(
      `
      SELECT id, name
      FROM member_groups
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all() as Array<{ id: string; name: string }>;

  const groups = groupRows.map((group) => {
    const memberIds = sqlite
      .prepare(
        `
        SELECT member_id AS memberId
        FROM member_group_members
        WHERE group_id = ?
        ORDER BY sort_order ASC
      `,
      )
      .all(group.id) as Array<{ memberId: string }>;

    return {
      id: group.id,
      memberIds: memberIds.map((row) => row.memberId),
      name: group.name,
    };
  });

  return createWorkspace({
    baseCurrency: workspaceRow.baseCurrency,
    groups,
    members: members.map((member) =>
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

function readAssets(sqlite: DatabaseConnection): ManualAsset[] {
  const workspace = readWorkspace(sqlite);

  if (!workspace) {
    return [];
  }

  const rows = sqlite
    .prepare(
      `
      SELECT
        id,
        name,
        type,
        currency,
        current_value_minor AS currentValueMinor,
        liquidity_tier AS liquidityTier,
        is_primary_residence AS isPrimaryResidence
      FROM assets
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all() as Array<{
    currency: string;
    currentValueMinor: number;
    id: string;
    isPrimaryResidence: 0 | 1;
    liquidityTier: CreateManualAssetInput["liquidityTier"];
    name: string;
    type: CreateManualAssetInput["type"];
  }>;

  return rows.map((row) =>
    createManualAsset(workspace, {
      currency: row.currency,
      currentValueMinor: row.currentValueMinor,
      id: row.id,
      isPrimaryResidence: row.isPrimaryResidence === 1,
      liquidityTier: row.liquidityTier,
      name: row.name,
      ownership: readAssetOwnership(sqlite, row.id),
      type: row.type,
    }),
  );
}

function readAssetOwnership(
  sqlite: DatabaseConnection,
  assetId: string,
): CreateManualAssetInput["ownership"] {
  const rows = sqlite
    .prepare(
      `
      SELECT member_id AS memberId, share_bps AS shareBps
      FROM asset_ownerships
      WHERE asset_id = ?
      ORDER BY member_id ASC
    `,
    )
    .all(assetId) as Array<{ memberId: string; shareBps: number }>;

  return rows;
}

function readLiabilities(sqlite: DatabaseConnection): Liability[] {
  const workspace = readWorkspace(sqlite);

  if (!workspace) {
    return [];
  }

  const rows = sqlite
    .prepare(
      `
      SELECT
        id,
        name,
        type,
        currency,
        current_balance_minor AS balanceMinor,
        associated_asset_id AS associatedAssetId
      FROM liabilities
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all() as Array<{
    associatedAssetId: string | null;
    balanceMinor: number;
    currency: string;
    id: string;
    name: string;
    type: CreateLiabilityInput["type"];
  }>;

  return rows.map((row) =>
    createLiability(workspace, {
      balanceMinor: row.balanceMinor,
      currency: row.currency,
      id: row.id,
      name: row.name,
      ownership: readLiabilityOwnership(sqlite, row.id),
      type: row.type,
      ...(row.associatedAssetId ? { associatedAssetId: row.associatedAssetId } : {}),
    }),
  );
}

function readLiabilityOwnership(
  sqlite: DatabaseConnection,
  liabilityId: string,
): CreateLiabilityInput["ownership"] {
  const rows = sqlite
    .prepare(
      `
      SELECT member_id AS memberId, share_bps AS shareBps
      FROM liability_ownerships
      WHERE liability_id = ?
      ORDER BY member_id ASC
    `,
    )
    .all(liabilityId) as Array<{ memberId: string; shareBps: number }>;

  return rows;
}

function readSnapshots(sqlite: DatabaseConnection, scopeId?: string): NetWorthSnapshot[] {
  const rows = scopeId
    ? sqlite
        .prepare(
          `
          SELECT *
          FROM snapshots
          WHERE scope_id = ?
          ORDER BY captured_at ASC, id ASC
        `,
        )
        .all(scopeId)
    : sqlite
        .prepare(
          `
          SELECT *
          FROM snapshots
          ORDER BY captured_at ASC, id ASC
        `,
        )
        .all();

  return (rows as SnapshotRow[]).map((row) => ({
    capturedAt: row.captured_at,
    dateKey: row.date_key,
    debts: {
      amountMinor: row.debts_minor,
      currency: row.currency,
    },
    grossAssets: {
      amountMinor: row.gross_assets_minor,
      currency: row.currency,
    },
    housingEquity: {
      amountMinor: row.housing_equity_minor,
      currency: row.currency,
    },
    id: row.id,
    isMonthlyClose: row.is_monthly_close === 1,
    liquidNetWorth: {
      amountMinor: row.liquid_net_worth_minor,
      currency: row.currency,
    },
    monthKey: row.month_key,
    scopeId: row.scope_id,
    scopeLabel: row.scope_label,
    totalNetWorth: {
      amountMinor: row.total_net_worth_minor,
      currency: row.currency,
    },
    warnings: JSON.parse(row.warnings_json) as string[],
  }));
}

interface SnapshotRow {
  id: string;
  scope_id: string;
  scope_label: string;
  captured_at: string;
  date_key: string;
  month_key: string;
  is_monthly_close: 0 | 1;
  currency: string;
  total_net_worth_minor: number;
  liquid_net_worth_minor: number;
  housing_equity_minor: number;
  gross_assets_minor: number;
  debts_minor: number;
  warnings_json: string;
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

import type { LocalPersistenceStatus } from "@worthline/domain";
import type {
  FireScopeConfig,
  InvestmentOperation,
  Liability,
  ManualValuePoint,
  ManualAsset,
  WarningOverride,
  Workspace,
} from "@worthline/domain";
import {
  buildSnapshotAtDate,
  historicalCapturedAt,
  listScopeOptions,
  recalculateSnapshotForAsset,
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
  auditLog,
} from "./schema";
import {
  createAssetStore,
  type AssetStore,
} from "./asset-store";
import { migrate } from "./migrate";
import {
  createLiabilityStore,
  type LiabilityStore,
} from "./liability-store";
import {
  createOperationsStore,
  type OperationsStore,
} from "./operations-store";
import {
  createSnapshotStore,
  readSnapshotHoldings,
  readSnapshots,
  type SaveSnapshotInput,
  type SnapshotStore,
} from "./snapshot-store";
import {
  createStoreContext,
  hardDeleteAssetTx,
  hardDeleteLiabilityTx,
  readAllOperations,
  readAssets,
  readLiabilities,
} from "./store-context";
import {
  createWorkspaceStore,
  readWorkspace,
  type WorkspaceStore,
} from "./workspace-store";

export type {
  AssetStore,
  CreateInvestmentAssetInput,
  InvestmentAssetFull,
  InvestmentAssetMeta,
  UpdateAssetInput,
  UpdateInvestmentAssetInput,
} from "./asset-store";
export type { LiabilityStore, UpdateLiabilityInput } from "./liability-store";
export type { OperationsStore, ValueUpdateCommand } from "./operations-store";
export type {
  PositionView,
  SaveSnapshotInput,
  SnapshotHoldingQuery,
  SnapshotHoldingRecord,
  SnapshotStore,
} from "./snapshot-store";
export type {
  InitializeWorkspaceInput,
  MemberOwnerships,
  WorkspaceStore,
} from "./workspace-store";

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

/**
 * The WorthlineStore is a pure composite (Slice R6, PRD #120): the five focused
 * sub-stores expose every per-domain operation, and the store itself owns only
 * the cross-cutting concerns that span domains or have no natural home in a
 * single sub-store (the connection lifecycle, the papelera, warning overrides,
 * the audit log, FIRE config, and the cross-domain historical-snapshot
 * machinery). All per-domain work goes through `store.<domain>.<method>`.
 */
export interface WorthlineStore {
  /** Focused snapshot & position store (Slice R1). */
  snapshots: SnapshotStore;
  /** Focused asset store (Slice R2). */
  assets: AssetStore;
  /** Focused liability store (Slice R3). */
  liabilities: LiabilityStore;
  /** Focused operations & price-cache store (Slice R4). */
  operations: OperationsStore;
  /** Focused workspace lifecycle & member store (Slice R5). */
  workspace: WorkspaceStore;

  // ── Cross-cutting (no per-domain home) ──────────────────────────────────────

  close: () => void;
  acknowledgeWarning: (code: string, entityId: string) => number;
  removeWarningOverride: (code: string, entityId: string) => void;
  readWarningOverrides: () => WarningOverride[];
  readTrash: () => TrashView;
  /** Hard-delete every trashed holding atomically. Returns how many of each kind were removed. */
  emptyTrash: () => { assets: number; liabilities: number };
  readAuditLog: (filter?: { entityId?: string }) => AuditLogEntry[];
  readFireConfig: () => Record<string, FireScopeConfig>;
  saveFireConfig: (scopeId: string, config: FireScopeConfig) => void;
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
  const liabilityStore = createLiabilityStore(ctx);
  const operationsStore = createOperationsStore(ctx);
  // importWorkspace's post-import gap-fill spans every domain and the snapshot
  // save path, so it stays in the monolith and is injected into the workspace
  // store as a dependency. The arrow defers reading store.snapshots.saveSnapshot until
  // call-time, by which point store is fully constructed (same forward-
  // reference pattern as rippleHistoricalSnapshotsForOperation).
  const workspaceStore = createWorkspaceStore(ctx, {
    gapFillHistoricalSnapshots: (workspace, today) =>
      gapFillHistoricalSnapshots(sqlite, workspace, store.snapshots.saveSnapshot, today),
  });

  const { getWorkspace } = ctx;

  const store: WorthlineStore = {
    snapshots: snapshotStore,
    assets: assetStore,
    liabilities: liabilityStore,
    operations: operationsStore,
    workspace: workspaceStore,
    close: () => {
      sqlite.close();
    },
    readFireConfig: () => {
      const { db } = ctx;
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
    saveFireConfig: (scopeId, config) => {
      const { db } = ctx;
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
          liabilities += hardDeleteLiabilityTx(ctx, row.id);

        return { assets, liabilities };
      })(),
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
      rippleHistoricalSnapshots(sqlite, workspace, store.snapshots.saveSnapshot, params);
    },
    backfillHistoricalSnapshots: (today) => {
      const workspace = getWorkspace();
      if (!workspace) return;
      gapFillHistoricalSnapshots(
        sqlite,
        workspace,
        store.snapshots.saveSnapshot,
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

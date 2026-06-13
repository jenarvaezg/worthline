import type {
  AssetPrice,
  ExportedAsset,
  ExportedLiability,
  ExportedSnapshot,
  FireScopeConfig,
  Member,
  MemberGroup,
  SnapshotHoldingRow,
  Workspace,
  WorkspaceExport,
  WorkspaceMode,
} from "@worthline/domain";
import {
  assertSnapshotHoldingsReconcile,
  createWorkspace,
  defaultInstrumentForAssetType,
  defaultInstrumentForLiability,
  serializeWorkspaceExport,
} from "@worthline/domain";
import { asc, count, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  appSettings,
  assetOperations,
  assetOwnerships,
  assetPriceCache,
  assets,
  liabilities,
  liabilityOwnerships,
  investmentAssets,
  memberGroupMembers,
  memberGroups,
  members,
  snapshotHoldings,
  snapshots,
  warningOverrides,
  workspace as workspaceTable,
} from "./schema";
import { readSnapshots } from "./snapshot-store";
import {
  readAssetOwnerships,
  readLiabilityOwnerships,
  toOperation,
  type StoreContext,
  type StoreDb,
} from "./store-context";

export interface InitializeWorkspaceInput {
  mode: WorkspaceMode;
  members: Member[];
  groups?: MemberGroup[];
}

/** Holdings a member still owns a share of — blocks the member's hard delete. */
export interface MemberOwnerships {
  assets: Array<{ id: string; name: string }>;
  liabilities: Array<{ id: string; name: string }>;
}

/**
 * Cross-domain orchestration the WorkspaceStore composes but does not own.
 * importWorkspace must gap-fill historical snapshots after the bulk insert
 * (ADR 0012, #112); that reconstruction lives outside this store (it spans every
 * domain and the snapshot save path), so it is injected rather than imported —
 * exactly mirroring how the monolith already composed it at the call site.
 */
export interface WorkspaceStoreDeps {
  /** Run the post-import historical-snapshot gap-fill against the live workspace. */
  gapFillHistoricalSnapshots: (workspace: Workspace, today: string) => void;
}

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

/**
 * Workspace lifecycle and member management (Slice R5 of the architectural
 * refactor, PRD #120 / #125). Owns the workspace row and its members/groups
 * (initialize, reset, read, member CRUD), plus the two whole-workspace
 * document paths — export (read-only) and import (atomic full replace, ADR
 * 0010). Read returns the memoized domain Workspace from the StoreContext.
 *
 * NOTE: importWorkspace duplicates the snapshot + holding INSERT shape that
 * saveSnapshot also runs. The duplication is deliberate (import does a raw
 * bulk insert with ids preserved and never the snapshot upsert path); a later
 * slice owns any deduplication.
 */
export interface WorkspaceStore {
  initializeWorkspace: (input: InitializeWorkspaceInput) => void;
  /** Empty every table in one transaction, returning the workspace to onboarding. */
  resetWorkspace: () => void;
  readWorkspace: () => Workspace | null;
  /**
   * Serialize the entire workspace into the versioned export document
   * (ADR 0010): live state, snapshot history, the papelera, and the price
   * cache. Read-only — exporting never writes. The audit log is not a section.
   * Throws when no workspace has been initialized.
   */
  exportWorkspace: () => WorkspaceExport;
  /**
   * Atomically replace the entire workspace with an already-validated export
   * document (ADR 0010, #103): every table is emptied and the file's sections
   * are bulk-inserted with their ids preserved. Callers must validate the
   * document with parseWorkspaceExport first — this method does not re-parse.
   */
  importWorkspace: (doc: WorkspaceExport) => void;
  createMember: (member: Member) => void;
  updateMember: (member: Pick<Member, "id" | "name">) => void;
  disableMember: (memberId: string, disabledAt: string) => void;
  reactivateMember: (memberId: string) => void;
  /** Hard-delete a member. Returns 0 (no-op) unless the member is disabled and owns no share of any holding. */
  hardDeleteMember: (memberId: string) => number;
  /** Holdings (live or trashed) the member owns a share of. Empty ⇒ the member may be hard-deleted. */
  readMemberOwnerships: (memberId: string) => MemberOwnerships;
}

export function createWorkspaceStore(
  ctx: StoreContext,
  deps: WorkspaceStoreDeps,
): WorkspaceStore {
  return {
    initializeWorkspace: (input) => initializeWorkspace(ctx, input),
    resetWorkspace: () => resetWorkspace(ctx),
    readWorkspace: () => ctx.getWorkspace(),
    exportWorkspace: () => buildWorkspaceExport(ctx.db, ctx.getWorkspace()),
    importWorkspace: (doc) => importWorkspace(ctx, deps, doc),
    createMember: (member) => createMember(ctx, member),
    updateMember: (member) => updateMember(ctx, member),
    disableMember: (memberId, disabledAt) => disableMember(ctx, memberId, disabledAt),
    reactivateMember: (memberId) => reactivateMember(ctx, memberId),
    hardDeleteMember: (memberId) => hardDeleteMember(ctx, memberId),
    readMemberOwnerships: (memberId) => readMemberOwnerships(ctx, memberId),
  };
}

/**
 * Read the workspace from the tables as a domain Workspace, or null before
 * initialization. Standalone (sqlite-only) so the StoreContext's workspace
 * cache can be seeded with it without a cycle: index.ts injects this into
 * createStoreContext, and every reader goes through the memoized getWorkspace.
 */
export function readWorkspace(db: StoreDb): Workspace | null {
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

function initializeWorkspace(ctx: StoreContext, input: InitializeWorkspaceInput): void {
  const { db } = ctx;
  const workspace = createWorkspace({
    baseCurrency: "EUR",
    members: input.members,
    mode: input.mode,
    ...(input.groups ? { groups: input.groups } : {}),
  });

  ctx.transaction(() => {
    db.delete(memberGroupMembers).run();
    db.delete(memberGroups).run();
    db.delete(members).run();
    db.delete(workspaceTable).run();

    db.insert(workspaceTable)
      .values({
        baseCurrency: workspace.baseCurrency,
        id: "default",
        mode: workspace.mode,
      })
      .run();

    if (workspace.members.length > 0) {
      db.insert(members)
        .values(
          workspace.members.map((member) => ({
            disabledAt: member.disabledAt ?? null,
            id: member.id,
            name: member.name,
          })),
        )
        .run();
    }

    for (const group of workspace.groups) {
      db.insert(memberGroups).values({ id: group.id, name: group.name }).run();

      if (group.memberIds.length > 0) {
        db.insert(memberGroupMembers)
          .values(
            group.memberIds.map((memberId, sortOrder) => ({
              groupId: group.id,
              memberId,
              sortOrder,
            })),
          )
          .run();
      }
    }
  });

  ctx.invalidateWorkspace();
}

function resetWorkspace(ctx: StoreContext): void {
  const { sqlite } = ctx;

  // WORKSPACE_TABLES is ordered children before parents so FK constraints
  // hold mid-transaction. The file and schema survive; the next read finds
  // no workspace and the app falls back to onboarding. Unlike a hard
  // delete, the reset erases history.
  //
  // STORE-RULE EXCEPTION (R12): this is a DELETE over a runtime list of table
  // *names*, which Drizzle's typed builder cannot express — so it stays on raw
  // SQL on purpose. importWorkspace shares the same wipe for the same reason.
  ctx.transaction(() => {
    for (const table of WORKSPACE_TABLES) {
      sqlite.prepare(`DELETE FROM ${table}`).run();
    }
  });

  ctx.invalidateWorkspace();
}

function createMember(ctx: StoreContext, member: Member): void {
  ctx.db
    .insert(members)
    .values({
      disabledAt: member.disabledAt ?? null,
      id: member.id,
      name: member.name,
    })
    .run();
  ctx.invalidateWorkspace();
}

function updateMember(ctx: StoreContext, member: Pick<Member, "id" | "name">): void {
  ctx.db
    .update(members)
    .set({ name: member.name, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(members.id, member.id))
    .run();
  ctx.invalidateWorkspace();
}

function disableMember(ctx: StoreContext, memberId: string, disabledAt: string): void {
  ctx.db
    .update(members)
    .set({ disabledAt, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(members.id, memberId))
    .run();
  ctx.invalidateWorkspace();
}

function reactivateMember(ctx: StoreContext, memberId: string): void {
  ctx.db
    .update(members)
    .set({ disabledAt: null, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(members.id, memberId))
    .run();
  ctx.invalidateWorkspace();
}

function hardDeleteMember(ctx: StoreContext, memberId: string): number {
  const { db } = ctx;
  const member = db
    .select({ name: members.name, disabledAt: members.disabledAt })
    .from(members)
    .where(eq(members.id, memberId))
    .get();

  // Only a disabled member owning no share of any holding (trashed ones
  // included) may be destroyed — mirrors the FK `restrict` as a domain rule
  // instead of letting the constraint throw.
  if (!member || member.disabledAt === null) {
    return 0;
  }

  const assetCount =
    db
      .select({ n: count() })
      .from(assetOwnerships)
      .where(eq(assetOwnerships.memberId, memberId))
      .get()?.n ?? 0;
  const liabilityCount =
    db
      .select({ n: count() })
      .from(liabilityOwnerships)
      .where(eq(liabilityOwnerships.memberId, memberId))
      .get()?.n ?? 0;

  if (assetCount + liabilityCount > 0) {
    return 0;
  }

  const result = db.delete(members).where(eq(members.id, memberId)).run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("hard_delete_member", "member", memberId, { name: member.name });
    ctx.invalidateWorkspace();
  }

  return result.changes;
}

function readMemberOwnerships(ctx: StoreContext, memberId: string): MemberOwnerships {
  const { db } = ctx;

  return {
    assets: db
      .select({ id: assets.id, name: assets.name })
      .from(assetOwnerships)
      .innerJoin(assets, eq(assets.id, assetOwnerships.assetId))
      .where(eq(assetOwnerships.memberId, memberId))
      .orderBy(asc(assets.name))
      .all(),
    liabilities: db
      .select({ id: liabilities.id, name: liabilities.name })
      .from(liabilityOwnerships)
      .innerJoin(liabilities, eq(liabilities.id, liabilityOwnerships.liabilityId))
      .where(eq(liabilityOwnerships.memberId, memberId))
      .orderBy(asc(liabilities.name))
      .all(),
  };
}

function importWorkspace(
  ctx: StoreContext,
  deps: WorkspaceStoreDeps,
  doc: WorkspaceExport,
): void {
  const { db, sqlite } = ctx;

  ctx.transaction(() => {
    // Full replace (ADR 0010): same wipe as resetWorkspace — a DELETE over a
    // runtime list of table *names*, which Drizzle's typed builder cannot
    // express, so it stays on raw SQL (the one store-rule exception, R12).
    // Then the file's sections are bulk-inserted with their ids preserved via
    // Drizzle — raw values on purpose, never the domain constructors that mint ids.
    for (const table of WORKSPACE_TABLES) {
      sqlite.prepare(`DELETE FROM ${table}`).run();
    }

    db.insert(workspaceTable)
      .values({
        baseCurrency: doc.workspace.baseCurrency,
        id: "default",
        mode: doc.workspace.mode,
      })
      .run();

    if (doc.members.length > 0) {
      db.insert(members)
        .values(
          doc.members.map((member) => ({
            disabledAt: member.disabledAt ?? null,
            id: member.id,
            name: member.name,
          })),
        )
        .run();
    }

    for (const group of doc.groups) {
      db.insert(memberGroups).values({ id: group.id, name: group.name }).run();

      if (group.memberIds.length > 0) {
        db.insert(memberGroupMembers)
          .values(
            group.memberIds.map((memberId, sortOrder) => ({
              groupId: group.id,
              memberId,
              sortOrder,
            })),
          )
          .run();
      }
    }

    const writeAsset = (asset: ExportedAsset): void => {
      db.insert(assets)
        .values({
          currency: asset.currency,
          // Investments are stored at zero like createInvestmentAsset does:
          // their value is derived from operations and prices on read, never
          // stored (ADR 0006). Hand-valued kinds carry the file's value.
          currentValueMinor:
            asset.type === "investment" ? 0 : (asset.currentValue?.amountMinor ?? 0),
          deletedAt: asset.deletedAt ?? null,
          id: asset.id,
          instrument:
            asset.instrument ??
            defaultInstrumentForAssetType(asset.type, asset.isPrimaryResidence ?? false),
          isPrimaryResidence: asset.isPrimaryResidence ? 1 : 0,
          liquidityTier: asset.liquidityTier,
          name: asset.name,
          type: asset.type,
        })
        .run();

      if (asset.ownership.length > 0) {
        db.insert(assetOwnerships)
          .values(
            asset.ownership.map((share) => ({
              assetId: asset.id,
              memberId: share.memberId,
              shareBps: share.shareBps,
            })),
          )
          .run();
      }

      // Every investment gets its metadata row (all-null when the file
      // carries none) — read paths expect the row to exist.
      if (asset.type === "investment") {
        db.insert(investmentAssets)
          .values({
            assetId: asset.id,
            isin: asset.investment?.isin ?? null,
            manualPricePerUnit: asset.investment?.manualPricePerUnit ?? null,
            manualPricedAt: asset.investment?.manualPricedAt ?? null,
            priceProvider: asset.investment?.priceProvider ?? null,
            providerSymbol: asset.investment?.providerSymbol ?? null,
            unitSymbol: asset.investment?.unitSymbol ?? null,
          })
          .run();
      }
    };

    // Trash entries land in the same tables with deleted_at set. All
    // assets go in before liabilities so associated_asset_id can point at
    // a trashed asset without tripping the FK.
    for (const asset of doc.assets) writeAsset(asset);
    for (const asset of doc.trash.assets) writeAsset(asset);

    const writeLiability = (liability: ExportedLiability): void => {
      db.insert(liabilities)
        .values({
          associatedAssetId: liability.associatedAssetId ?? null,
          currency: liability.currency,
          currentBalanceMinor: liability.currentBalance.amountMinor,
          deletedAt: liability.deletedAt ?? null,
          id: liability.id,
          instrument:
            liability.instrument ?? defaultInstrumentForLiability(liability.type, null),
          name: liability.name,
          type: liability.type,
        })
        .run();

      if (liability.ownership.length > 0) {
        db.insert(liabilityOwnerships)
          .values(
            liability.ownership.map((share) => ({
              liabilityId: liability.id,
              memberId: share.memberId,
              shareBps: share.shareBps,
            })),
          )
          .run();
      }
    };

    for (const liability of doc.liabilities) writeLiability(liability);
    for (const liability of doc.trash.liabilities) writeLiability(liability);

    if (doc.operations.length > 0) {
      db.insert(assetOperations)
        .values(
          doc.operations.map((operation) => ({
            assetId: operation.assetId,
            currency: operation.currency,
            executedAt: operation.executedAt,
            feesMinor: operation.feesMinor,
            id: operation.id,
            kind: operation.kind,
            pricePerUnit: operation.pricePerUnit,
            units: operation.units,
          })),
        )
        .run();
    }

    if (doc.warningOverrides.length > 0) {
      db.insert(warningOverrides)
        .values(
          doc.warningOverrides.map((override) => ({
            code: override.code,
            entityId: override.entityId,
          })),
        )
        .run();
    }

    // The whole fire config record lands in the single app_settings row
    // exactly as saveFireConfig leaves it.
    if (Object.keys(doc.fireConfig).length > 0) {
      db.insert(appSettings)
        .values({
          key: "fire.config",
          updatedAt: new Date().toISOString(),
          value: JSON.stringify(doc.fireConfig),
        })
        .run();
    }

    for (const snapshot of doc.snapshots) {
      // Defence in depth (ADR 0008): the parser already checked this, but
      // a capture whose rows contradict its own figures must never persist.
      if (snapshot.holdings.length > 0) {
        assertSnapshotHoldingsReconcile(snapshot.holdings, {
          debtsMinor: snapshot.debts.amountMinor,
          grossAssetsMinor: snapshot.grossAssets.amountMinor,
        });
      }

      db.insert(snapshots)
        .values({
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
        })
        .run();

      // The file's holding rows carry no row ids — mint fresh ones.
      if (snapshot.holdings.length > 0) {
        db.insert(snapshotHoldings)
          .values(
            snapshot.holdings.map((row) => ({
              holdingId: row.holdingId,
              id: randomUUID(),
              kind: row.kind,
              label: row.label,
              liquidityTier: row.liquidityTier,
              snapshotId: snapshot.id,
              unitPrice: row.unitPrice ?? null,
              units: row.units ?? null,
              valueMinor: row.valueMinor,
            })),
          )
          .run();
      }
    }

    if (doc.priceCache.length > 0) {
      db.insert(assetPriceCache)
        .values(
          doc.priceCache.map((price) => ({
            assetId: price.assetId,
            currency: price.currency,
            fetchedAt: price.fetchedAt,
            freshnessState: price.freshnessState,
            price: price.price,
            priceDate: price.priceDate ?? null,
            source: price.source,
            staleReason: price.staleReason ?? null,
          })),
        )
        .run();
    }

    // One audit entry inside the transaction: a failed import leaves no
    // trace, a successful one starts the fresh log with its section counts.
    ctx.writeAuditEntry("import_workspace", "workspace", "default", {
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

  ctx.invalidateWorkspace();

  // Gap-fill historical snapshots (ADR 0012, Slice 3 / #112): generate
  // snapshots for imported operation dates that have no snapshot in the
  // file. Imported snapshots are restored intact and never recalculated —
  // they were captured with real contemporaneous data. Runs outside the
  // import transaction so each save owns its own transaction.
  const importedWorkspace = ctx.getWorkspace();
  if (importedWorkspace) {
    const today = new Date().toISOString().slice(0, 10);
    try {
      deps.gapFillHistoricalSnapshots(importedWorkspace, today);
    } catch (error) {
      // The import itself already committed (ADR 0010). Gap-fill is a
      // best-effort post-step: surface its failure without rolling back a
      // successful import — the user can re-run the backfill later.
      console.error("Historical-snapshot gap-fill after import failed:", error);
    }
  }
}

/**
 * Serialize the entire workspace into the versioned export document
 * (ADR 0010). Strictly read-only: every section is read from the tables and
 * the final assembly is delegated to the domain's serializeWorkspaceExport.
 * The audit log is deliberately not a section.
 */
function buildWorkspaceExport(db: StoreDb, workspace: Workspace | null): WorkspaceExport {
  if (!workspace) {
    throw new Error("Workspace must be initialized before exporting.");
  }

  // Assets — live and trashed — with ownership and investment metadata.
  const assetRows = db
    .select()
    .from(assets)
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();
  const ownershipByAsset = readAssetOwnerships(db);
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
      instrument:
        row.instrument ??
        defaultInstrumentForAssetType(row.type, row.isPrimaryResidence === 1),
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
  const ownershipByLiability = readLiabilityOwnerships(db);

  const toExportedLiability = (
    row: typeof liabilities.$inferSelect,
  ): ExportedLiability => ({
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    currentBalance: { amountMinor: row.currentBalanceMinor, currency: row.currency },
    instrument: row.instrument ?? defaultInstrumentForLiability(row.type, row.debtModel),
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

  const warningOverrideRows = db
    .select({ code: warningOverrides.code, entityId: warningOverrides.entityId })
    .from(warningOverrides)
    .orderBy(asc(warningOverrides.code), asc(warningOverrides.entityId))
    .all();

  const fireRow = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "fire.config"))
    .get();
  const fireConfig = fireRow
    ? (JSON.parse(fireRow.value) as Record<string, FireScopeConfig>)
    : {};

  // Snapshots across all scopes, each carrying its frozen holding rows.
  const holdingsBySnapshot = readHoldingRowsBySnapshot(db);
  const exportedSnapshots: ExportedSnapshot[] = readSnapshots(db).map((snapshot) => ({
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

/**
 * Every frozen holding row grouped by its owning snapshot, in insertion
 * (rowid) order — the deterministic order the rows were captured in. SQLite's
 * implicit rowid has no schema column, so the ORDER BY drops to a raw `sql`
 * fragment inside the otherwise-Drizzle query.
 */
function readHoldingRowsBySnapshot(db: StoreDb): Map<string, SnapshotHoldingRow[]> {
  const rows = db
    .select({
      snapshotId: snapshotHoldings.snapshotId,
      holdingId: snapshotHoldings.holdingId,
      kind: snapshotHoldings.kind,
      label: snapshotHoldings.label,
      liquidityTier: snapshotHoldings.liquidityTier,
      valueMinor: snapshotHoldings.valueMinor,
      units: snapshotHoldings.units,
      unitPrice: snapshotHoldings.unitPrice,
    })
    .from(snapshotHoldings)
    .orderBy(sql`rowid ASC`)
    .all();

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

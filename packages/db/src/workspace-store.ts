import type { Member, MemberGroup, Workspace, WorkspaceMode } from "@worthline/domain";
import { createWorkspace, listScopeOptions } from "@worthline/domain";
import { and, asc, count, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  ensureAgentViewPublicIds,
  publicIdTargetsForMember,
  publicIdTargetsForWorkspace,
} from "./agent-view-public-ids";
import {
  agentViewPublicIds,
  assetOwnerships,
  assets,
  liabilities,
  liabilityOwnerships,
  memberGroupMembers,
  memberGroups,
  members,
  snapshotHoldings,
  snapshots,
  workspace as workspaceTable,
} from "./schema";
import type { StoreContext, StoreDb } from "./store-context";
import { wipeWorkspaceTables } from "./workspace-tables";

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
 * Workspace lifecycle and member management (Slice R5 of the architectural
 * refactor, PRD #120 / #125). Owns the workspace row and its members/groups:
 * initialize, reset, read, member CRUD. Read returns the memoized domain
 * Workspace from the StoreContext.
 *
 * The export/import document paths are the other half, in
 * `workspace-document-store.ts`; `WorkspaceStore` in `store-types.ts` joins them.
 */
export interface WorkspaceLifecycleStore {
  initializeWorkspace: (input: InitializeWorkspaceInput) => Promise<void>;
  /** Empty every table in one transaction, returning the workspace to onboarding. */
  resetWorkspace: () => Promise<void>;
  readWorkspace: () => Promise<Workspace | null>;
  createMember: (member: Member) => Promise<void>;
  updateMember: (member: Pick<Member, "id" | "name">) => Promise<void>;
  /** Overwrite a member's profile (PRD #421, #423): unset fields are cleared to NULL. */
  updateMemberProfile: (
    memberId: string,
    profile: Pick<Member, "birthYear" | "birthMonth" | "fiscalCountry" | "riskTolerance">,
  ) => Promise<void>;
  disableMember: (memberId: string, disabledAt: string) => Promise<void>;
  reactivateMember: (memberId: string) => Promise<void>;
  /** Hard-delete a member. Returns 0 (no-op) unless the member is disabled and owns no share of any holding. */
  hardDeleteMember: (memberId: string) => Promise<number>;
  /** Holdings (live or trashed) the member owns a share of. Empty ⇒ the member may be hard-deleted. */
  readMemberOwnerships: (memberId: string) => Promise<MemberOwnerships>;
}

export function createWorkspaceLifecycleStore(
  ctx: StoreContext,
): WorkspaceLifecycleStore {
  return {
    initializeWorkspace: (input) => initializeWorkspace(ctx, input),
    resetWorkspace: () => resetWorkspace(ctx),
    readWorkspace: () => ctx.getWorkspace(),
    createMember: (member) => createMember(ctx, member),
    updateMember: (member) => updateMember(ctx, member),
    updateMemberProfile: (memberId, profile) =>
      updateMemberProfile(ctx, memberId, profile),
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
export async function readWorkspace(db: StoreDb): Promise<Workspace | null> {
  const workspaceRow = await db
    .select({ baseCurrency: workspaceTable.baseCurrency, mode: workspaceTable.mode })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, "default"))
    .get();

  if (!workspaceRow) {
    return null;
  }

  const memberRows = await db
    .select({
      birthMonth: members.birthMonth,
      birthYear: members.birthYear,
      disabledAt: members.disabledAt,
      fiscalCountry: members.fiscalCountry,
      id: members.id,
      name: members.name,
      riskTolerance: members.riskTolerance,
    })
    .from(members)
    .orderBy(asc(members.createdAt), asc(members.id))
    .all();

  const groupRows = await db
    .select({ id: memberGroups.id, name: memberGroups.name })
    .from(memberGroups)
    .orderBy(asc(memberGroups.createdAt), asc(memberGroups.id))
    .all();

  const groups = await Promise.all(
    groupRows.map(async (group) => {
      const groupMembers = await db
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
    }),
  );

  return createWorkspace({
    baseCurrency: workspaceRow.baseCurrency,
    groups,
    members: memberRows.map((member) => ({
      id: member.id,
      name: member.name,
      ...(member.disabledAt ? { disabledAt: member.disabledAt } : {}),
      ...(member.birthYear != null ? { birthYear: member.birthYear } : {}),
      ...(member.birthMonth != null ? { birthMonth: member.birthMonth } : {}),
      ...(member.fiscalCountry != null ? { fiscalCountry: member.fiscalCountry } : {}),
      ...(member.riskTolerance != null ? { riskTolerance: member.riskTolerance } : {}),
    })),
    mode: workspaceRow.mode,
  });
}

async function initializeWorkspace(
  ctx: StoreContext,
  input: InitializeWorkspaceInput,
): Promise<void> {
  const { db } = ctx;
  const workspace = createWorkspace({
    baseCurrency: "EUR",
    members: input.members,
    mode: input.mode,
    ...(input.groups ? { groups: input.groups } : {}),
  });

  await ctx.transaction(async () => {
    await db.delete(memberGroupMembers).run();
    await db.delete(agentViewPublicIds).run();
    await db.delete(memberGroups).run();
    await db.delete(members).run();
    await db.delete(workspaceTable).run();

    await db
      .insert(workspaceTable)
      .values({
        baseCurrency: workspace.baseCurrency,
        id: "default",
        mode: workspace.mode,
      })
      .run();

    if (workspace.members.length > 0) {
      await db
        .insert(members)
        .values(
          workspace.members.map((member) => ({
            birthMonth: member.birthMonth ?? null,
            birthYear: member.birthYear ?? null,
            disabledAt: member.disabledAt ?? null,
            fiscalCountry: member.fiscalCountry ?? null,
            id: member.id,
            name: member.name,
            riskTolerance: member.riskTolerance ?? null,
          })),
        )
        .run();
    }

    for (const group of workspace.groups) {
      await db.insert(memberGroups).values({ id: group.id, name: group.name }).run();

      if (group.memberIds.length > 0) {
        await db
          .insert(memberGroupMembers)
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

    await ensureAgentViewPublicIds(ctx, publicIdTargetsForWorkspace(workspace));
  });

  ctx.invalidateWorkspace();
}

async function resetWorkspace(ctx: StoreContext): Promise<void> {
  // The shared wipe is ordered children before parents so FK constraints hold
  // mid-transaction. The file and schema survive; the next read finds no
  // workspace and the app falls back to onboarding. Unlike a hard delete, the
  // reset erases history. importWorkspace runs the same wipe.
  await ctx.transaction(async () => {
    await wipeWorkspaceTables(ctx.client);
  });

  ctx.invalidateWorkspace();
}

async function createMember(ctx: StoreContext, member: Member): Promise<void> {
  await ctx.transaction(async () => {
    await ctx.db
      .insert(members)
      .values({
        birthMonth: member.birthMonth ?? null,
        birthYear: member.birthYear ?? null,
        disabledAt: member.disabledAt ?? null,
        fiscalCountry: member.fiscalCountry ?? null,
        id: member.id,
        name: member.name,
        riskTolerance: member.riskTolerance ?? null,
      })
      .run();
    await ensureAgentViewPublicIds(ctx, publicIdTargetsForMember(member));
  });
  ctx.invalidateWorkspace();
}

async function updateMember(
  ctx: StoreContext,
  member: Pick<Member, "id" | "name">,
): Promise<void> {
  await ctx.db
    .update(members)
    .set({ name: member.name, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(members.id, member.id))
    .run();
  ctx.invalidateWorkspace();
}

async function updateMemberProfile(
  ctx: StoreContext,
  memberId: string,
  profile: Pick<Member, "birthYear" | "birthMonth" | "fiscalCountry" | "riskTolerance">,
): Promise<void> {
  await ctx.db
    .update(members)
    .set({
      birthMonth: profile.birthMonth ?? null,
      birthYear: profile.birthYear ?? null,
      fiscalCountry: profile.fiscalCountry ?? null,
      riskTolerance: profile.riskTolerance ?? null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(members.id, memberId))
    .run();
  ctx.invalidateWorkspace();
}

/**
 * Enforce "live scopes only" (#306): delete every snapshot — and its frozen
 * holding rows (ADR 0008) — whose `scope_id` is no longer one `listScopeOptions`
 * offers. Call AFTER the scope-dropping write and AFTER invalidating the cached
 * workspace, INSIDE the same transaction, so the drop and the purge commit (or
 * roll back) together. No `rippleHistoricalSnapshots*` path ever revisits an
 * orphaned scope (they all iterate `listScopeOptions`), so its snapshots would
 * otherwise rot — stale frozen rows that contradict the live operation ledger.
 *
 * The `household` scope is always in `listScopeOptions`, so it is never purged
 * and the canonical history survives any composition change. Frozen rows are
 * deleted first, then the parent snapshots — explicit (not FK-cascade-reliant)
 * so the purge is correct regardless of the connection's foreign-key pragma.
 */
async function purgeOrphanedScopeSnapshots(ctx: StoreContext): Promise<void> {
  const { db } = ctx;
  const workspace = await ctx.getWorkspace();

  // No workspace ⇒ nothing offers any scope; leave snapshots untouched (a reset
  // owns that wipe). With a workspace, the offered scope ids are the survivors.
  if (!workspace) {
    return;
  }

  const liveScopeIds = listScopeOptions(workspace).map((option) => option.id);

  // Frozen rows of every snapshot whose scope is no longer offered.
  const orphanSnapshotRows = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(notInArray(snapshots.scopeId, liveScopeIds))
    .all();
  const orphanSnapshotIds = orphanSnapshotRows.map((row) => row.id);

  if (orphanSnapshotIds.length === 0) {
    return;
  }

  await db
    .delete(snapshotHoldings)
    .where(inArray(snapshotHoldings.snapshotId, orphanSnapshotIds))
    .run();
  await db.delete(snapshots).where(inArray(snapshots.id, orphanSnapshotIds)).run();
}

async function disableMember(
  ctx: StoreContext,
  memberId: string,
  disabledAt: string,
): Promise<void> {
  await ctx.transaction(async () => {
    await ctx.db
      .update(members)
      .set({ disabledAt, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(members.id, memberId))
      .run();
    // The disabled member's scope is no longer offered — purge its snapshots in
    // the same transaction as the drop (#306).
    ctx.invalidateWorkspace();
    await purgeOrphanedScopeSnapshots(ctx);
  });
  ctx.invalidateWorkspace();
}

async function reactivateMember(ctx: StoreContext, memberId: string): Promise<void> {
  await ctx.db
    .update(members)
    .set({ disabledAt: null, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(members.id, memberId))
    .run();
  ctx.invalidateWorkspace();
}

async function hardDeleteMember(ctx: StoreContext, memberId: string): Promise<number> {
  const { db } = ctx;
  const member = await db
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
    (
      await db
        .select({ n: count() })
        .from(assetOwnerships)
        .where(eq(assetOwnerships.memberId, memberId))
        .get()
    )?.n ?? 0;
  const liabilityCount =
    (
      await db
        .select({ n: count() })
        .from(liabilityOwnerships)
        .where(eq(liabilityOwnerships.memberId, memberId))
        .get()
    )?.n ?? 0;

  if (assetCount + liabilityCount > 0) {
    return 0;
  }

  const result = await ctx.transaction(async () => {
    const deleted = await db.delete(members).where(eq(members.id, memberId)).run();

    if (deleted.rowsAffected > 0) {
      await db
        .delete(agentViewPublicIds)
        .where(
          and(
            eq(agentViewPublicIds.entityId, memberId),
            inArray(agentViewPublicIds.entityType, ["member", "scope"]),
          ),
        )
        .run();
      await ctx.writeAuditEntry("hard_delete_member", "member", memberId, {
        name: member.name,
      });
      // The deleted member's scope is no longer offered — purge its snapshots in
      // the same transaction as the drop (#306).
      ctx.invalidateWorkspace();
      await purgeOrphanedScopeSnapshots(ctx);
    }

    return deleted;
  });

  if (result.rowsAffected > 0) {
    ctx.invalidateWorkspace();
  }

  return result.rowsAffected;
}

async function readMemberOwnerships(
  ctx: StoreContext,
  memberId: string,
): Promise<MemberOwnerships> {
  const { db } = ctx;

  return {
    assets: await db
      .select({ id: assets.id, name: assets.name })
      .from(assetOwnerships)
      .innerJoin(assets, eq(assets.id, assetOwnerships.assetId))
      .where(eq(assetOwnerships.memberId, memberId))
      .orderBy(asc(assets.name))
      .all(),
    liabilities: await db
      .select({ id: liabilities.id, name: liabilities.name })
      .from(liabilityOwnerships)
      .innerJoin(liabilities, eq(liabilities.id, liabilityOwnerships.liabilityId))
      .where(eq(liabilityOwnerships.memberId, memberId))
      .orderBy(asc(liabilities.name))
      .all(),
  };
}

import type {
  ManagedPortfolio,
  ManagedPortfolioWitness,
  OwnershipShare,
} from "@worthline/domain";
import {
  assertManagedPortfolioInput,
  assertManagedPortfolioWitnessInput,
  createManualAsset,
} from "@worthline/domain";
import { asc, eq, inArray, sql } from "drizzle-orm";

import {
  ensureAgentViewPublicIds,
  publicIdTargetsForHolding,
  publicIdTargetsForManagedPortfolio,
} from "./agent-view-public-ids";
import {
  assetOwnerships,
  assets,
  managedPortfolioHoldings,
  managedPortfolios,
} from "./schema";
import type { StoreContext } from "./store-context";

/**
 * Managed portfolio persistence (ADR 0085, #1547) — the "cartera gestionada"
 * rows and their EXCLUSIVE memberships.
 *
 * The entity stores only what somebody typed (name, optional provider, and the
 * last declared balance since #1550). Its value is derived from the members on
 * read — no total lives here to go stale behind a member's price — and the
 * declared balance is a WITNESS the engine never reads: it exists so a careo can
 * disagree out loud, never to plug a figure (#1422). Registration auto-creates the container's cash as a
 * sibling holding: a normal `current_account` at 0 € that keeps summing into
 * net worth like any other member, so valuation, snapshots and health come for
 * free instead of a parallel cash machinery on the entity. Membership rules are
 * enforced at the door (live, investment, manual — never connected-source),
 * because the form only ever offers eligible holdings and no other writer gets
 * to bypass them. The connection's foreign-key pragma is not assumed on (same
 * rule as the goal store): deletes remove link rows explicitly.
 */

export interface CreateManagedPortfolioInput {
  scopeId: string;
  name: string;
  /** The manager behind it ("Indexa", "MyInvestor"), when the owner says one. */
  provider?: string | null;
  /** Investment members linked at birth; the cash sibling is added automatically. */
  memberHoldingIds?: string[];
  /**
   * The cash sibling's ownership split. Caller-resolved (the alta knows the
   * scope it was created from), then validated by the domain constructor here.
   */
  cashOwnership: OwnershipShare[];
}

export interface UpdateManagedPortfolioPatch {
  name?: string;
  provider?: string | null;
  /**
   * Replaces the INVESTMENT members wholesale (the form paints every eligible
   * holding, so an absent chip means "quit", never "leave as it was"). The cash
   * sibling is always preserved — it is the portfolio's own plumbing, not an
   * assignable member.
   */
  memberHoldingIds?: string[];
}

export interface ManagedPortfolioStore {
  /** Portfolios (optionally for one scope) with their member ids; ordered by name. */
  readManagedPortfolios: (scopeId?: string) => Promise<ManagedPortfolio[]>;
  createManagedPortfolio: (
    input: CreateManagedPortfolioInput,
  ) => Promise<ManagedPortfolio>;
  updateManagedPortfolio: (
    id: string,
    patch: UpdateManagedPortfolioPatch,
  ) => Promise<void>;
  deleteManagedPortfolio: (id: string) => Promise<void>;
  /**
   * Declare (or clear, with `null`) the portfolio's last read balance (#1550).
   * A write of its own rather than a field of the edit patch: it is a DATED FACT
   * about a day, it gets its own audit row (the only place the succession of
   * declared balances is kept until a connector can produce the series), and the
   * form that types it is not the form that assigns members.
   */
  declareManagedPortfolioBalance: (
    id: string,
    witness: ManagedPortfolioWitness | null,
  ) => Promise<void>;
  /**
   * The portfolio whose CASH sibling this holding is, by name — or null when it is
   * not one (#1549). The Papelera's gate reads it to refuse, and the ficha reads it
   * to say so before the owner tries; one query so the two cannot disagree.
   */
  readCashContainerName: (holdingId: string) => Promise<string | null>;
}

export function createManagedPortfolioStore(ctx: StoreContext): ManagedPortfolioStore {
  return {
    createManagedPortfolio: (input) => createManagedPortfolio(ctx, input),
    declareManagedPortfolioBalance: (id, witness) =>
      declareManagedPortfolioBalance(ctx, id, witness),
    deleteManagedPortfolio: (id) => deleteManagedPortfolio(ctx, id),
    readCashContainerName: (holdingId) => readCashContainerPortfolioName(ctx, holdingId),
    readManagedPortfolios: (scopeId) => readManagedPortfolios(ctx, scopeId),
    updateManagedPortfolio: (id, patch) => updateManagedPortfolio(ctx, id, patch),
  };
}

/**
 * The name of the managed portfolio whose CASH sibling this holding is, or null.
 *
 * Only the cash box is protected from the Papelera (#1549), not every member: a
 * member fund is an ordinary position with an ordinary ledger, and selling it and
 * archiving it is a legitimate thing to do inside a live cartera. The cash is
 * different — the alta created it, the owner never did, and while the cartera lives
 * it is a casilla of the container (ADR 0085). Members other than the cash sibling
 * are investments by construction, so "is a member and is not an investment" IS "is
 * the cash box".
 *
 * A plain function as well as a store method: the gate calls it from inside
 * `softDeleteAsset`, where there is a `ctx` and no store.
 */
export async function readCashContainerPortfolioName(
  ctx: StoreContext,
  holdingId: string,
): Promise<string | null> {
  const row = await ctx.db
    .select({ name: managedPortfolios.name, type: assets.type })
    .from(managedPortfolioHoldings)
    .innerJoin(
      managedPortfolios,
      eq(managedPortfolios.id, managedPortfolioHoldings.portfolioId),
    )
    .innerJoin(assets, eq(assets.id, managedPortfolioHoldings.assetId))
    .where(eq(managedPortfolioHoldings.assetId, holdingId))
    .get();

  return row && row.type !== "investment" ? row.name : null;
}

function normalizeProvider(provider: string | null | undefined): string | null {
  const trimmed = provider?.trim();
  return trimmed ? trimmed : null;
}

/** Members are a set: the same holding twice would double its weight. */
function normalizeHoldingIds(holdingIds: readonly string[]): string[] {
  return [...new Set(holdingIds.map((id) => id.trim()).filter(Boolean))];
}

/**
 * Every member must be a LIVE, MANUAL, INVESTMENT holding that belongs to no
 * other portfolio. Sync-owned holdings cannot be members for now (ADR 0085):
 * their rows are written by a connector, and a rebalance the owner never saw
 * must not silently rewrite a grouping he declared by hand.
 */
async function assertMemberEligibility(
  ctx: StoreContext,
  holdingIds: readonly string[],
  currentPortfolioId: string | undefined,
): Promise<void> {
  if (holdingIds.length === 0) return;

  const rows = await ctx.db
    .select({
      connectedSourceId: assets.connectedSourceId,
      deletedAt: assets.deletedAt,
      id: assets.id,
      type: assets.type,
    })
    .from(assets)
    .where(inArray(assets.id, [...holdingIds]))
    .all();
  const rowById = new Map(rows.map((row) => [row.id, row]));

  for (const holdingId of holdingIds) {
    const row = rowById.get(holdingId);
    if (row === undefined) {
      throw new Error(`El activo "${holdingId}" no existe.`);
    }
    if (row.deletedAt != null) {
      throw new Error(
        `El activo "${holdingId}" está en la papelera: la membresía necesita un holding vivo.`,
      );
    }
    // Sync-owned rows carry their source id on the row itself — checked before
    // the instrument rule so a connector holding is named for what it is.
    if (row.connectedSourceId != null) {
      throw new Error(
        `El activo "${holdingId}" viene de una fuente conectada y no puede entrar en una cartera gestionada (de momento).`,
      );
    }
    if (row.type !== "investment") {
      throw new Error(
        "Solo los holdings de inversión pueden ser miembros de una cartera gestionada.",
      );
    }
  }

  // Exclusive membership (the UNIQUE index on asset_id backs this at the wire).
  // A position lives physically inside ONE portfolio; overlap would be a data
  // error, not a legitimate second view.
  const taken = await ctx.db
    .select({
      assetId: managedPortfolioHoldings.assetId,
      portfolioId: managedPortfolioHoldings.portfolioId,
    })
    .from(managedPortfolioHoldings)
    .where(inArray(managedPortfolioHoldings.assetId, [...holdingIds]))
    .all();

  const conflicts = taken.filter(
    (link) =>
      link.portfolioId !== currentPortfolioId && holdingIds.includes(link.assetId),
  );
  if (conflicts.length > 0) {
    const names = await ctx.db
      .select({ id: managedPortfolios.id, name: managedPortfolios.name })
      .from(managedPortfolios)
      .where(
        inArray(
          managedPortfolios.id,
          conflicts.map((link) => link.portfolioId),
        ),
      )
      .all();
    const nameById = new Map(names.map((row) => [row.id, row.name]));
    const first = conflicts[0]!;
    throw new Error(
      `El activo "${first.assetId}" ya pertenece a la cartera "${nameById.get(first.portfolioId) ?? first.portfolioId}"; una posición solo puede estar en una.`,
    );
  }
}

async function readMemberRowsWithTypes(
  ctx: StoreContext,
  portfolioId: string,
): Promise<Array<{ assetId: string; assetType: string }>> {
  return ctx.db
    .select({ assetId: managedPortfolioHoldings.assetId, assetType: assets.type })
    .from(managedPortfolioHoldings)
    .innerJoin(assets, eq(assets.id, managedPortfolioHoldings.assetId))
    .where(eq(managedPortfolioHoldings.portfolioId, portfolioId))
    .orderBy(asc(managedPortfolioHoldings.assetId))
    .all();
}

async function readManagedPortfolios(
  ctx: StoreContext,
  scopeId?: string,
): Promise<ManagedPortfolio[]> {
  const rows = await ctx.db
    .select()
    .from(managedPortfolios)
    .where(scopeId ? eq(managedPortfolios.scopeId, scopeId) : undefined)
    .orderBy(asc(managedPortfolios.name), asc(managedPortfolios.id))
    .all();

  if (rows.length === 0) return [];

  const links = await ctx.db
    .select()
    .from(managedPortfolioHoldings)
    .where(
      inArray(
        managedPortfolioHoldings.portfolioId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(managedPortfolioHoldings.assetId))
    .all();

  const holdingsByPortfolio = new Map<string, string[]>();
  for (const link of links) {
    const list = holdingsByPortfolio.get(link.portfolioId) ?? [];
    list.push(link.assetId);
    holdingsByPortfolio.set(link.portfolioId, list);
  }

  return rows.map((row) => ({
    holdingIds: holdingsByPortfolio.get(row.id) ?? [],
    id: row.id,
    name: row.name,
    provider: row.provider ?? null,
    scopeId: row.scopeId,
    witness: witnessOf(row),
  }));
}

/**
 * The three witness columns travel together: any one missing reads as "no
 * witness declared" rather than a half-witness the careo would have to guess at.
 */
function witnessOf(row: {
  declaredValueMinor: number | null;
  declaredCurrency: string | null;
  declaredDate: string | null;
}): ManagedPortfolioWitness | null {
  if (
    row.declaredValueMinor == null ||
    row.declaredCurrency == null ||
    row.declaredDate == null
  ) {
    return null;
  }

  return {
    declaredDate: row.declaredDate,
    declaredValue: {
      amountMinor: row.declaredValueMinor,
      currency: row.declaredCurrency,
    },
  };
}

/**
 * Store or clear the declared balance. The value is validated by the domain
 * (positive, dated) and written as-is: the book keeps deriving its own total, so
 * a witness that turns out to be wrong is corrected by declaring another one —
 * nothing downstream was moved by it.
 */
async function declareManagedPortfolioBalance(
  ctx: StoreContext,
  id: string,
  witness: ManagedPortfolioWitness | null,
): Promise<void> {
  const existing = await ctx.db
    .select({ id: managedPortfolios.id })
    .from(managedPortfolios)
    .where(eq(managedPortfolios.id, id))
    .get();
  if (!existing) throw new Error(`Managed portfolio "${id}" not found.`);

  if (witness !== null) {
    assertManagedPortfolioWitnessInput({
      declaredDate: witness.declaredDate,
      declaredValueMinor: witness.declaredValue.amountMinor,
    });
  }

  await ctx.db
    .update(managedPortfolios)
    .set({
      declaredCurrency: witness?.declaredValue.currency ?? null,
      declaredDate: witness?.declaredDate ?? null,
      declaredValueMinor: witness?.declaredValue.amountMinor ?? null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(managedPortfolios.id, id))
    .run();

  // The audit row is the only durable trace of the SUCCESSION of declared
  // balances (the entity keeps just the latest), so it carries the figures.
  await ctx.writeAuditEntry(
    "declare_managed_portfolio_balance",
    "managed_portfolio",
    id,
    witness === null
      ? { cleared: true }
      : {
          declaredCurrency: witness.declaredValue.currency,
          declaredDate: witness.declaredDate,
          declaredValueMinor: witness.declaredValue.amountMinor,
        },
  );
}

async function createManagedPortfolio(
  ctx: StoreContext,
  input: CreateManagedPortfolioInput,
): Promise<ManagedPortfolio> {
  const name = input.name.trim();
  assertManagedPortfolioInput({ name });
  if (!input.scopeId.trim()) throw new Error("scopeId is required.");
  const provider = normalizeProvider(input.provider);
  const members = normalizeHoldingIds(input.memberHoldingIds ?? []);
  await assertMemberEligibility(ctx, members, undefined);

  const workspace = await ctx.getWorkspace();
  if (!workspace) {
    throw new Error("Workspace must be initialized before creating portfolios.");
  }

  // The cash sibling is a NORMAL current_account holding: the domain constructor
  // validates currency/ownership exactly as every manual alta does, so nothing
  // about it is special except who created it.
  const cashName = `Efectivo ${name}`;
  const cash = createManualAsset(workspace, {
    currency: workspace.baseCurrency,
    currentValueMinor: 0,
    id: ctx.newId(),
    instrument: "current_account",
    liquidityTier: "cash",
    name: cashName,
    ownership: input.cashOwnership,
    type: "cash",
  });

  const id = ctx.newId();

  await ctx.transaction(async () => {
    await ctx.db
      .insert(managedPortfolios)
      .values({ id, name, provider, scopeId: input.scopeId })
      .run();

    await ctx.db
      .insert(assets)
      .values({
        currency: cash.currency,
        currentValueMinor: cash.currentValue.amountMinor,
        id: cash.id,
        instrument: cash.instrument,
        isPrimaryResidence: 0,
        liquidityTier: cash.liquidityTier,
        name: cash.name,
        type: cash.type,
      })
      .run();
    await ctx.db
      .insert(assetOwnerships)
      .values(
        cash.ownership.map((share) => ({
          assetId: cash.id,
          memberId: share.memberId,
          shareBps: share.shareBps,
        })),
      )
      .run();

    // Both the portfolio and its cash sibling get agent-view public ids on
    // creation (#335 discipline) — the ficha is addressed by the wl_prt_ one.
    await ensureAgentViewPublicIds(ctx, [
      ...publicIdTargetsForManagedPortfolio(id),
      ...publicIdTargetsForHolding(cash.id),
    ]);

    await insertMembers(ctx, id, [cash.id, ...members]);
  });

  await ctx.writeAuditEntry("create_managed_portfolio", "managed_portfolio", id);

  return {
    holdingIds: [cash.id, ...members].sort(),
    id,
    name,
    provider,
    scopeId: input.scopeId,
    // An alta declares no balance: the witness is typed on the ficha afterwards.
    witness: null,
  };
}

async function updateManagedPortfolio(
  ctx: StoreContext,
  id: string,
  patch: UpdateManagedPortfolioPatch,
): Promise<void> {
  const existing = await ctx.db
    .select()
    .from(managedPortfolios)
    .where(eq(managedPortfolios.id, id))
    .get();
  if (!existing) throw new Error(`Managed portfolio "${id}" not found.`);

  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  assertManagedPortfolioInput({ name });
  const provider =
    patch.provider === undefined
      ? (existing.provider ?? null)
      : normalizeProvider(patch.provider);

  // The cash sibling is identified by what it IS (the member whose asset is a
  // cash holding), not by a stored pointer — it is a normal holding and stays
  // manageable through every normal seam.
  const memberRows = await readMemberRowsWithTypes(ctx, id);
  const cashAssetId = memberRows.find((row) => row.assetType === "cash")?.assetId ?? null;

  let finalMembers: string[] | undefined;
  if (patch.memberHoldingIds !== undefined) {
    const requested = normalizeHoldingIds(patch.memberHoldingIds);
    finalMembers = requested.filter((holdingId) => holdingId !== cashAssetId);
    await assertMemberEligibility(ctx, finalMembers, id);
  }

  await ctx.transaction(async () => {
    await ctx.db
      .update(managedPortfolios)
      .set({ name, provider, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(managedPortfolios.id, id))
      .run();

    if (finalMembers !== undefined) {
      await ctx.db
        .delete(managedPortfolioHoldings)
        .where(eq(managedPortfolioHoldings.portfolioId, id))
        .run();
      const next = cashAssetId ? [cashAssetId, ...finalMembers] : finalMembers;
      await insertMembers(ctx, id, next);
    }
  });

  await ctx.writeAuditEntry("update_managed_portfolio", "managed_portfolio", id);
}

async function deleteManagedPortfolio(ctx: StoreContext, id: string): Promise<void> {
  await ctx.transaction(async () => {
    // Explicit link removal — the FK cascade is not assumed on. Every member
    // holding (cash included) survives: dissolving a group never deletes money.
    await ctx.db
      .delete(managedPortfolioHoldings)
      .where(eq(managedPortfolioHoldings.portfolioId, id))
      .run();
    await ctx.db.delete(managedPortfolios).where(eq(managedPortfolios.id, id)).run();
  });

  await ctx.writeAuditEntry("delete_managed_portfolio", "managed_portfolio", id);
}

async function insertMembers(
  ctx: StoreContext,
  portfolioId: string,
  holdingIds: readonly string[],
): Promise<void> {
  if (holdingIds.length === 0) return;
  await ctx.db
    .insert(managedPortfolioHoldings)
    .values([...new Set(holdingIds)].map((assetId) => ({ assetId, portfolioId })))
    .run();
}

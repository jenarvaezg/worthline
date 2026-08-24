import type {
  ManagedPortfolio,
  ManagedPortfolioWitness,
  OwnershipShare,
} from "@worthline/domain";
import {
  assertManagedPortfolioInput,
  assertManagedPortfolioWitnessInput,
  assertUndetailedValueInput,
  createManualAsset,
  managedPortfolioMemberRoles,
  undetailedMemberName,
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
 * disagree out loud, never to plug a figure (#1422).
 *
 * Registration auto-creates the container's cash as a sibling holding: a normal
 * `current_account` at 0 € that keeps summing into net worth like any other
 * member, so valuation, snapshots and health come for free instead of a parallel
 * cash machinery on the entity. An alta that declares a balance without
 * enumerating the composition (#1551) also gets ONE aggregate "(sin detallar)"
 * member worth that balance — same idea, same ordinary holding — so the
 * patrimonio is honest from minute one. Membership rules are
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
   * Register WITHOUT enumerating the composition (#1551): the portfolio is born
   * with one aggregate "(sin detallar)" member of stored valuation worth this
   * much, so the patrimonio is honest from minute one instead of under-counted
   * until the owner lists every fund. Absent for a portfolio registered with its
   * funds; a non-positive figure is refused — a 0 € aggregate stands for nothing.
   */
  undetailedValueMinor?: number;
  /**
   * The ownership split of the holdings the ALTA creates (the cash sibling and,
   * when asked for, the "(sin detallar)" aggregate) — the container's own
   * plumbing. Caller-resolved (the alta knows the scope it was created from),
   * then validated by the domain constructor here.
   */
  containerOwnership: OwnershipShare[];
}

export interface UpdateManagedPortfolioPatch {
  name?: string;
  provider?: string | null;
  /**
   * Replaces the INVESTMENT members wholesale (the form paints every eligible
   * holding, so an absent chip means "quit", never "leave as it was"). The
   * holdings the ALTA created — the cash sibling and the "(sin detallar)"
   * aggregate (#1551) — are always preserved: they are the portfolio's own
   * plumbing, not assignable members, and neither is ever offered as a chip.
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
 * it is a casilla of the container (ADR 0085). The test is the member's own type:
 * since #1551 a portfolio can also hold a stored "(sin detallar)" aggregate, which
 * is invested money the owner retires himself the moment he finishes detailing —
 * so "not an investment" would protect precisely the row that must stay archivable.
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

  return row && row.type === "cash" ? row.name : null;
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
    witness: managedPortfolioWitnessOfRow(row),
  }));
}

/**
 * The three witness columns travel together: any one missing reads as "no
 * witness declared" rather than a half-witness the careo would have to guess at.
 *
 * Exported because the workspace export reads the same row shape (#1550): two
 * copies of an all-or-nothing rule are two chances to disagree about what a half
 * witness means.
 */
export function managedPortfolioWitnessOfRow(row: {
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
    assertManagedPortfolioWitnessInput(witness);
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

/**
 * Insert one of the holdings the ALTA creates (the cash sibling, the "(sin
 * detallar)" aggregate) plus its ownership rows. Both are ORDINARY holdings —
 * the domain constructor validated them exactly as it validates a hand-typed
 * alta — so the only thing they share is who created them.
 */
async function insertPlumbingHolding(
  ctx: StoreContext,
  holding: ReturnType<typeof createManualAsset>,
): Promise<void> {
  await ctx.db
    .insert(assets)
    .values({
      currency: holding.currency,
      currentValueMinor: holding.currentValue.amountMinor,
      id: holding.id,
      instrument: holding.instrument,
      isPrimaryResidence: 0,
      liquidityTier: holding.liquidityTier,
      name: holding.name,
      type: holding.type,
    })
    .run();
  await ctx.db
    .insert(assetOwnerships)
    .values(
      holding.ownership.map((share) => ({
        assetId: holding.id,
        memberId: share.memberId,
        shareBps: share.shareBps,
      })),
    )
    .run();
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

  const undetailedValueMinor = input.undetailedValueMinor;
  if (undetailedValueMinor !== undefined) {
    assertUndetailedValueInput(undetailedValueMinor);
    // The two altas are exclusive AT THE DOOR, not just in the form: the declared
    // balance the aggregate is born at is the value of the WHOLE composition, so
    // an alta that also enumerates funds would count the same money twice.
    if (members.length > 0) {
      throw new Error(
        "Una cartera se da de alta con sus fondos o con su saldo sin detallar, no con las dos cosas: el saldo representa la composición entera.",
      );
    }
  }

  const workspace = await ctx.getWorkspace();
  if (!workspace) {
    throw new Error("Workspace must be initialized before creating portfolios.");
  }

  // The cash sibling is a NORMAL current_account holding: the domain constructor
  // validates currency/ownership exactly as every manual alta does, so nothing
  // about it is special except who created it.
  const cash = createManualAsset(workspace, {
    currency: workspace.baseCurrency,
    currentValueMinor: 0,
    id: ctx.newId(),
    instrument: "current_account",
    liquidityTier: "cash",
    name: `Efectivo ${name}`,
    ownership: input.containerOwnership,
    type: "cash",
  });

  /**
   * Registering without enumerating (#1551): ONE aggregate member standing for
   * the whole composition, so the gross patrimonio is right from minute one.
   *
   * It is a stored-valuation holding (`other`) rather than an investment,
   * because an investment's value is DERIVED from its operations (ADR 0006) and
   * the owner has no participaciones, price or trade date to give — inventing
   * them is the cost/date fabrication #1490 named a wall. On the `market` rung
   * because that is what the money is: invested and sellable, not an illiquid
   * oddity. Reducing and retiring it are the ordinary value-update and Papelera
   * seams — nothing about it is special except who created it.
   */
  const aggregate =
    undetailedValueMinor === undefined
      ? null
      : createManualAsset(workspace, {
          currency: workspace.baseCurrency,
          currentValueMinor: undetailedValueMinor,
          id: ctx.newId(),
          instrument: "other",
          liquidityTier: "market",
          name: undetailedMemberName(name),
          ownership: input.containerOwnership,
          type: "manual",
        });

  const id = ctx.newId();
  const plumbingHoldingIds = [cash.id, ...(aggregate ? [aggregate.id] : [])];

  await ctx.transaction(async () => {
    await ctx.db
      .insert(managedPortfolios)
      .values({ id, name, provider, scopeId: input.scopeId })
      .run();

    await insertPlumbingHolding(ctx, cash);
    if (aggregate) await insertPlumbingHolding(ctx, aggregate);

    // The portfolio and every holding the alta created get agent-view public ids
    // on creation (#335 discipline) — the ficha is addressed by the wl_prt_ one.
    await ensureAgentViewPublicIds(ctx, [
      ...publicIdTargetsForManagedPortfolio(id),
      ...plumbingHoldingIds.flatMap((holdingId) => publicIdTargetsForHolding(holdingId)),
    ]);

    await insertMembers(ctx, id, [...plumbingHoldingIds, ...members]);
  });

  await ctx.writeAuditEntry("create_managed_portfolio", "managed_portfolio", id);

  return {
    holdingIds: [...plumbingHoldingIds, ...members].sort(),
    id,
    name,
    provider,
    scopeId: input.scopeId,
    // An alta declares no balance: the witness is typed on the ficha afterwards,
    // or by the alta itself right after this write (#1551) — through the same
    // single door every declaration goes through.
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

  // The holdings the ALTA created are identified by what they ARE (the cash box,
  // the "(sin detallar)" aggregate of #1551 — the domain's own classifier, so no
  // second definition lives here), not by a stored pointer — they are normal holdings and stay manageable
  // through every normal seam. Neither is ever a chip, so a save that does not
  // mention them is not a save that removes them.
  const memberRows = await readMemberRowsWithTypes(ctx, id);
  const roles = managedPortfolioMemberRoles(
    memberRows.map((row) => row.assetId),
    new Map(memberRows.map((row) => [row.assetId, row.assetType])),
  );
  const plumbingAssetIds = [roles.cashHoldingId, roles.undetailedHoldingId].filter(
    (holdingId): holdingId is string => holdingId !== null,
  );

  let finalMembers: string[] | undefined;
  if (patch.memberHoldingIds !== undefined) {
    const requested = normalizeHoldingIds(patch.memberHoldingIds);
    finalMembers = requested.filter((holdingId) => !plumbingAssetIds.includes(holdingId));
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
      await insertMembers(ctx, id, [...plumbingAssetIds, ...finalMembers]);
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

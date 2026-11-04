import type { CreateInvestmentAssetInput } from "@db/asset-store";
import { chunk } from "@db/chunk";
import { readAppliedFactKeys } from "@db/connected-source-owning-store";
import { closeHoldingPlansOnLink } from "@db/contribution-plan-store";
import { readHoldingLedgers, readSplitTransfers } from "@db/holding-ledger-reads";
import {
  insertConnectedManagedPortfolio,
  joinConnectedManagedPortfolio,
} from "@db/managed-portfolio-store";
import {
  assetOperations,
  assets,
  connectedSourceLinks,
  connectedSources,
  connectorAppliedFacts,
  factBatchReplacedOperations,
  investmentAssets,
  managedPortfolioHoldings,
  managedPortfolios,
} from "@db/schema";
import type { StoreContext } from "@db/store-context";
import type {
  CreateInvestmentOperationInput,
  CreateManualAssetInput,
  ManagedPortfolioWitness,
  NormalizedBatch,
  SecurityId,
} from "@worthline/domain";
import { isMirroredSourceAdapter, reconcileFacts } from "@worthline/domain";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import { commitReconciled } from "./connector-commit";
import {
  rippleHistoricalSnapshotsForOperations,
  throwCommandResultError,
} from "./ripple-engine";
import type { UnitOfWork } from "./types";

/** One holding an owning source creates for a product it found (#1880). */
export interface ConnectedHoldingCreation {
  /** The product's strong identifier at the source (ADR 0115, #1869 P3). */
  productKey: string;
  holding:
    | { kind: "investment"; asset: CreateInvestmentAssetInput }
    /** A cash account: a stored balance, with no movements (#1869 P4). */
    | { kind: "cash"; asset: CreateManualAssetInput };
}

/**
 * One holding that already exists BY HAND and becomes the source's (#1881, ADR 0115
 * decisions 5 and 6): the source's operations replace its manual ones.
 */
export interface ConnectedHoldingLink {
  /** The product's strong identifier at the source. */
  productKey: string;
  /** The live manual investment it becomes. */
  assetId: string;
  /**
   * The product's identifier, written onto a holding that carries none (one that
   * was only alike by name): a holding that already has one keeps it.
   */
  securityId?: SecurityId;
}

/**
 * A manual cash account that becomes the source's (#1883): the cash sibling of a
 * managed portfolio kept by hand, when the robo-advisor's block is linked with it.
 * Its balance becomes the source's — a stored balance, with no movements (#1869 P4).
 */
export interface ConnectedCashLink {
  productKey: string;
  assetId: string;
  balanceMinor: number;
}

/**
 * A managed portfolio the source brings whole (#1883, ADR 0085 as amended): a
 * robo-advisor's account, grouping holdings THIS batch creates.
 */
export interface ConnectedPortfolioCreation {
  /** The portfolio's key at the source; its members carry their own links. */
  productKey: string;
  name: string;
  provider: string | null;
  scopeId: string;
  /** The created holdings it groups, its cash sibling included. */
  memberAssetIds: readonly string[];
  witness: ManagedPortfolioWitness | null;
}

/**
 * A managed portfolio kept by hand that the source takes over as a block (#1883):
 * its members are linked (`links`), its cash sibling too (`cashLinks`), and the
 * funds it lacked are created and join it.
 */
export interface ConnectedPortfolioLink {
  productKey: string;
  portfolioId: string;
  /** Holdings this batch creates that join it (funds it did not have, or its cash). */
  addMemberAssetIds: readonly string[];
  witness: ManagedPortfolioWitness | null;
}

/**
 * Including products of a source that OWNS its holdings (#1880, ADR 0115): the
 * holdings to create, the manual holdings to link (#1881), and the operations that
 * give them their history, as the ingestion port carries them — each operation a
 * fact with its dedup key, written into the holding it belongs to.
 */
export interface IncludeConnectedHoldingsCommand {
  sourceId: string;
  today: string;
  holdings: readonly ConnectedHoldingCreation[];
  /** Manual holdings that become the source's (#1881); none when absent. */
  links?: readonly ConnectedHoldingLink[];
  /** Manual cash accounts that become the source's (#1883); none when absent. */
  cashLinks?: readonly ConnectedCashLink[];
  /** Managed portfolios the source brings whole (#1883); none when absent. */
  portfolios?: readonly ConnectedPortfolioCreation[];
  /** Managed portfolios kept by hand the source takes over (#1883); none when absent. */
  portfolioLinks?: readonly ConnectedPortfolioLink[];
  /** The operations, keyed for the dedup ledger; the cursor is where the port resumes. */
  facts: NormalizedBatch<CreateInvestmentOperationInput>;
}

export interface IncludeConnectedHoldingsResult {
  created: number;
  /** Manual holdings that became the source's (#1881). */
  linked: number;
  /** Managed portfolios created or taken over as a block (#1883). */
  portfolios: number;
  applied: number;
}

/**
 * A periodic sync of a source that owns its holdings (#1884, ADR 0114 decision 5):
 * the operations of the window the port read — the ledger drops the ones already
 * applied — and today's balance of each linked cash account.
 */
export interface SyncConnectedHoldingsCommand {
  sourceId: string;
  today: string;
  facts: NormalizedBatch<CreateInvestmentOperationInput>;
  /** A linked cash account's balance today (#1869 P4): stored, with no movements. */
  cashBalances: readonly { assetId: string; valueMinor: number }[];
  /**
   * The balance a linked robo-advisor's manager declares today, by a member of its
   * block (#1883): the portfolio that member lives in takes it as its witness.
   */
  portfolioWitnesses?: readonly { assetId: string; witness: ManagedPortfolioWitness }[];
}

export interface SyncConnectedHoldingsResult {
  applied: number;
}

const LEDGER_ROWS_PER_INSERT = 100;

/**
 * The first start of an owning source, and every later «Incluir con su histórico»
 * (#1880, ADR 0115 decision 1): its holdings and their whole history land in ONE
 * `fact_batch`, ONE transaction and ONE ripple (ADR 0062), through the ingestion
 * port's commit (ADR 0066) — the facts are reconciled against the source's dedup
 * ledger, and the ledger and the cursor advance with them.
 *
 * Linking a manual holding (#1881) rides the SAME batch: its manual operations are
 * moved out of the book into `fact_batch_replaced_operations` under this batch's id
 * (the provenance, ADR 0062), its contribution plan closes today (ADR 0115 decision
 * 5), and the ripple's floor reaches the earliest of the replaced and the incoming
 * dates, so every snapshot either side touched is re-derived once.
 *
 * The periodic sync (#1884) is the same commit with nothing to create or link: the
 * new operations of the linked holdings and the balances of the linked cash
 * accounts, under the `sync` trigger.
 *
 * What it refuses, by throwing inside the transaction so nothing lands:
 * - a source that does not exist or mirrors instead of owning;
 * - a product that is already linked, or named twice (a second include of the same
 *   product would create its twin);
 * - a holding to link that is not a live manual investment, or named twice;
 * - a holding with half a traspaso whose other half is not replaced with it;
 * - an operation or a balance for a holding this source does not own.
 */
export function createConnectedInclusionCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
  uow: UnitOfWork,
): Pick<
  DatedFactCommandImplementations,
  "includeConnectedHoldingsAndRipple" | "syncConnectedHoldingsAndRipple"
> {
  return {
    includeConnectedHoldingsAndRipple: async (command) => {
      const links = command.links ?? [];
      const cashLinks = command.cashLinks ?? [];
      const applied = await commitOwnedFacts(ctx, stores, uow, {
        beforeFacts: async (batchId) => {
          await assertProductsUnlinked(ctx, command.sourceId, [
            ...command.holdings.map((entry) => entry.productKey),
            ...links.map((link) => link.productKey),
            ...cashLinks.map((link) => link.productKey),
          ]);
          assertPortfolioMembersCreated(command);
          await assertPortfoliosTakenWhole(ctx, command);
          await createLinkedHoldings(ctx, stores, command.sourceId, command.holdings);
          const replaced = await linkManualHoldings(ctx, {
            batchId,
            links,
            sourceId: command.sourceId,
            today: command.today,
          });
          await linkManualCash(ctx, command.sourceId, cashLinks);
          await groupPortfolios(ctx, command);
          return replaced;
        },
        facts: command.facts,
        sourceId: command.sourceId,
        today: command.today,
        trigger: "connect",
      });
      return {
        applied,
        created: command.holdings.length,
        linked: links.length,
        portfolios:
          (command.portfolios?.length ?? 0) + (command.portfolioLinks?.length ?? 0),
      };
    },
    syncConnectedHoldingsAndRipple: async (command) => {
      const applied = await commitOwnedFacts(ctx, stores, uow, {
        beforeFacts: async () => {
          await writeLinkedCashBalances(ctx, command.sourceId, command.cashBalances);
          await refreshPortfolioWitnesses(
            ctx,
            command.sourceId,
            command.portfolioWitnesses ?? [],
          );
          return new Map();
        },
        facts: command.facts,
        sourceId: command.sourceId,
        today: command.today,
        trigger: "sync",
      });
      return { applied };
    },
  };
}

/**
 * The commit the include and the sync share: reconcile against the ledger — read
 * only for the keys of the batch (#1884), never the whole history of the account —
 * run `beforeFacts` and write the facts inside the batch's ONE transaction, advance
 * the ledger and the cursor with them, and ripple once. `beforeFacts` returns, per
 * holding, the days of the operations it removed (a link's replaced rows): they
 * belong in the ripple's floor as much as the new ones.
 */
async function commitOwnedFacts(
  ctx: StoreContext,
  stores: DatedFactStores,
  uow: UnitOfWork,
  input: {
    sourceId: string;
    today: string;
    trigger: "connect" | "sync";
    facts: NormalizedBatch<CreateInvestmentOperationInput>;
    beforeFacts: (batchId: string) => Promise<Map<string, string[]>>;
  },
): Promise<number> {
  const { sourceId, today } = input;
  const workspace = await ctx.getWorkspace();
  if (!workspace) throw new Error("Workspace must be initialized before including.");

  const source = await ctx.db
    .select({ adapter: connectedSources.adapter })
    .from(connectedSources)
    .where(eq(connectedSources.id, sourceId))
    .get();
  if (!source || isMirroredSourceAdapter(source.adapter)) {
    throw new Error(`Connected source "${sourceId}" does not own holdings.`);
  }

  const plan = reconcileFacts(
    input.facts,
    await readAppliedFactKeys(
      ctx,
      sourceId,
      input.facts.facts.map((fact) => fact.key),
    ),
  );
  const dateKeysByAsset = new Map<string, string[]>();

  const result = await commitReconciled<CreateInvestmentOperationInput>({
    connectedSourceId: sourceId,
    plan,
    today,
    trigger: input.trigger,
    uow,
    persistFacts: async (facts, batchId) => {
      const replaced = await input.beforeFacts(batchId);
      for (const [assetId, keys] of replaced) dateKeysByAsset.set(assetId, keys);
      const operations = facts.map((fact) => fact.payload);
      await stores.operations.recordSourceOperations(sourceId, operations, {
        batchId,
      });
      for (const fact of facts) {
        const keys = dateKeysByAsset.get(fact.payload.assetId) ?? [];
        keys.push(fact.dateKey);
        dateKeysByAsset.set(fact.payload.assetId, keys);
      }
      return [...facts.map((fact) => fact.dateKey), ...[...replaced.values()].flat()];
    },
    recordCommit: async ({ appliedKeys, batchId, cursor }) => {
      for (const keys of chunk(appliedKeys, LEDGER_ROWS_PER_INSERT)) {
        await ctx.db
          .insert(connectorAppliedFacts)
          .values(keys.map((factKey) => ({ batchId, factKey, sourceId })))
          .run();
      }
      // The cursor only moves forward: including a product later, from an older
      // read, must not send the next sync back over days it already covered.
      // The comparison is the UPDATE's own condition, inside the transaction:
      // a cursor read before it opened could be overtaken by another include.
      if (cursor !== null) {
        await ctx.db
          .update(connectedSources)
          .set({ ingestCursor: cursor, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(connectedSources.id, sourceId),
              or(
                isNull(connectedSources.ingestCursor),
                lt(connectedSources.ingestCursor, cursor),
              ),
            ),
          )
          .run();
      }
    },
    // ONE ripple over every holding the batch touched (#1435): the floor the
    // batch computed is the earliest of these dates.
    ripple: async () => {
      await rippleHistoricalSnapshotsForOperations(
        ctx,
        workspace,
        stores.snapshots.saveSnapshot,
        {
          assets: [...dateKeysByAsset].map(([assetId, operationDateKeys]) => ({
            assetId,
            operationDateKeys,
          })),
          today,
        },
      );
    },
  });

  if (!result.ok) throwCommandResultError(result);
  return result.value.applied;
}

/**
 * Today's balance of each linked cash account (#1884, #1869 P4). Only into a
 * holding linked to THIS source: the store refuses a hand-set value on a linked
 * holding, and the source must not reach one it does not own either.
 */
async function writeLinkedCashBalances(
  ctx: StoreContext,
  sourceId: string,
  balances: readonly { assetId: string; valueMinor: number }[],
): Promise<void> {
  if (balances.length === 0) return;
  for (const { valueMinor } of balances) {
    if (!Number.isInteger(valueMinor)) {
      throw new Error("Money must be stored as integer minor units.");
    }
  }
  const assetIds = [...new Set(balances.map((balance) => balance.assetId))];
  const linked = new Set(
    (
      await ctx.db
        .select({ id: assets.id })
        .from(assets)
        .where(and(inArray(assets.id, assetIds), eq(assets.connectedSourceId, sourceId)))
        .all()
    ).map((row) => row.id),
  );
  const stranger = assetIds.find((assetId) => !linked.has(assetId));
  if (stranger !== undefined) {
    throw new Error(
      `Connected source "${sourceId}" cannot write the balance of holding "${stranger}": ` +
        "it is not linked to that source.",
    );
  }
  for (const { assetId, valueMinor } of balances) {
    await ctx.db
      .update(assets)
      .set({ currentValueMinor: valueMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(assets.id, assetId))
      .run();
    await ctx.writeAuditEntry("update_valuation", "asset", assetId, {
      currentValueMinor: valueMinor,
    });
  }
}

/** A portfolio the source brings whole groups only holdings this batch creates. */
function assertPortfolioMembersCreated(command: IncludeConnectedHoldingsCommand): void {
  const created = new Set(command.holdings.map(({ holding }) => holding.asset.id));
  const joining = [
    ...(command.portfolios ?? []).flatMap((portfolio) => portfolio.memberAssetIds),
    ...(command.portfolioLinks ?? []).flatMap((link) => link.addMemberAssetIds),
  ];
  const stray = joining.find((assetId) => !created.has(assetId));
  if (stray !== undefined) {
    throw new Error(
      `Holding "${stray}" joins a portfolio but this batch does not create it.`,
    );
  }
}

/**
 * A portfolio kept by hand is taken over WHOLE or not at all (#1883): every
 * live member must be one this batch links — a fund to its product, the cash
 * sibling to the source's cash. A member left manual would sit inside a group the
 * source now writes, and the robo-advisor does not have it.
 */
async function assertPortfoliosTakenWhole(
  ctx: StoreContext,
  command: IncludeConnectedHoldingsCommand,
): Promise<void> {
  const portfolioLinks = command.portfolioLinks ?? [];
  const linkingIds = [
    ...(command.links ?? []).map((link) => link.assetId),
    ...(command.cashLinks ?? []).map((link) => link.assetId),
  ];
  // A member of a portfolio kept by hand is linked with its whole portfolio, never
  // on its own: one fund the source's would leave the rest of the group manual.
  if (linkingIds.length > 0) {
    const takenOver = new Set(portfolioLinks.map((link) => link.portfolioId));
    const memberships = await ctx.db
      .select({
        assetId: managedPortfolioHoldings.assetId,
        portfolioId: managedPortfolioHoldings.portfolioId,
      })
      .from(managedPortfolioHoldings)
      .where(inArray(managedPortfolioHoldings.assetId, linkingIds))
      .all();
    const loose = memberships.find((row) => !takenOver.has(row.portfolioId));
    if (loose) {
      throw new Error(
        `Holding "${loose.assetId}" is a member of portfolio "${loose.portfolioId}": ` +
          "it is linked with its whole portfolio, not on its own.",
      );
    }
  }
  if (portfolioLinks.length === 0) return;
  const ids = portfolioLinks.map((link) => link.portfolioId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("The same portfolio cannot be linked twice in one batch.");
  }
  const found = await ctx.db
    .select({ id: managedPortfolios.id })
    .from(managedPortfolios)
    .where(inArray(managedPortfolios.id, ids))
    .all();
  if (found.length !== ids.length) {
    throw new Error("A portfolio to link does not exist.");
  }
  const linking = new Set([
    ...(command.links ?? []).map((link) => link.assetId),
    ...(command.cashLinks ?? []).map((link) => link.assetId),
  ]);
  const members = await ctx.db
    .select({
      assetId: managedPortfolioHoldings.assetId,
      connectedSourceId: assets.connectedSourceId,
      deletedAt: assets.deletedAt,
      portfolioId: managedPortfolioHoldings.portfolioId,
      type: assets.type,
    })
    .from(managedPortfolioHoldings)
    .innerJoin(assets, eq(assets.id, managedPortfolioHoldings.assetId))
    .where(inArray(managedPortfolioHoldings.portfolioId, ids))
    .all();
  // A member already the source's is fine: a block linked earlier whose manager
  // bought a fund since takes the new one in (#1883). So is the container's cash
  // box when the source brings no cash account for it: it stays the owner's, the
  // same rule the fold's careo applies (`myInvestorPortfolioCandidate`).
  const left = members.find(
    (member) =>
      member.deletedAt === null &&
      member.connectedSourceId !== command.sourceId &&
      member.type !== "cash" &&
      !linking.has(member.assetId),
  );
  if (left) {
    throw new Error(
      `Holding "${left.assetId}" is in portfolio "${left.portfolioId}" and is not linked: ` +
        "a portfolio is linked whole.",
    );
  }
}

/**
 * Make live manual cash accounts the source's (#1883): each takes the source's
 * balance, and from then on only the source writes it.
 */
async function linkManualCash(
  ctx: StoreContext,
  sourceId: string,
  cashLinks: readonly ConnectedCashLink[],
): Promise<void> {
  if (cashLinks.length === 0) return;
  const assetIds = cashLinks.map((link) => link.assetId);
  if (new Set(assetIds).size !== assetIds.length) {
    throw new Error("The same cash account cannot be linked twice in one batch.");
  }
  const rows = await ctx.db
    .select({
      connectedSourceId: assets.connectedSourceId,
      deletedAt: assets.deletedAt,
      id: assets.id,
      type: assets.type,
    })
    .from(assets)
    .where(inArray(assets.id, assetIds))
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const link of cashLinks) {
    const row = byId.get(link.assetId);
    if (
      !row ||
      row.type !== "cash" ||
      row.connectedSourceId !== null ||
      row.deletedAt !== null
    ) {
      throw new Error(
        `Holding "${link.assetId}" is not a live manual cash account: it cannot be linked.`,
      );
    }
    if (!Number.isInteger(link.balanceMinor)) {
      throw new Error("Money must be stored as integer minor units.");
    }
    await ctx.db
      .update(assets)
      .set({
        connectedSourceId: sourceId,
        currentValueMinor: link.balanceMinor,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(assets.id, link.assetId))
      .run();
    await ctx.writeAuditEntry("update_valuation", "asset", link.assetId, {
      currentValueMinor: link.balanceMinor,
    });
  }
  await ctx.db
    .insert(connectedSourceLinks)
    .values(
      cashLinks.map((link) => ({
        assetId: link.assetId,
        productKey: link.productKey,
        sourceId,
      })),
    )
    .run();
}

/**
 * Today's declared balance of each linked robo-advisor (#1883): into the portfolio
 * its member lives in, and only through a member this source owns.
 */
async function refreshPortfolioWitnesses(
  ctx: StoreContext,
  sourceId: string,
  witnesses: readonly { assetId: string; witness: ManagedPortfolioWitness }[],
): Promise<void> {
  if (witnesses.length === 0) return;
  const rows = await ctx.db
    .select({
      assetId: managedPortfolioHoldings.assetId,
      portfolioId: managedPortfolioHoldings.portfolioId,
    })
    .from(managedPortfolioHoldings)
    .innerJoin(assets, eq(assets.id, managedPortfolioHoldings.assetId))
    .where(
      and(
        inArray(
          managedPortfolioHoldings.assetId,
          witnesses.map((entry) => entry.assetId),
        ),
        eq(assets.connectedSourceId, sourceId),
      ),
    )
    .all();
  const portfolioOf = new Map(rows.map((row) => [row.assetId, row.portfolioId]));
  for (const { assetId, witness } of witnesses) {
    const portfolioId = portfolioOf.get(assetId);
    // A block whose portfolio the owner dissolved has nowhere to keep it.
    if (portfolioId === undefined) continue;
    await joinConnectedManagedPortfolio(ctx, {
      addMemberHoldingIds: [],
      portfolioId,
      witness,
    });
  }
}

/** Create the portfolios the source brings whole and join the ones it takes over. */
async function groupPortfolios(
  ctx: StoreContext,
  command: IncludeConnectedHoldingsCommand,
): Promise<void> {
  for (const portfolio of command.portfolios ?? []) {
    await insertConnectedManagedPortfolio(ctx, {
      memberHoldingIds: portfolio.memberAssetIds,
      name: portfolio.name,
      provider: portfolio.provider,
      scopeId: portfolio.scopeId,
      witness: portfolio.witness,
    });
  }
  for (const link of command.portfolioLinks ?? []) {
    // A member in the Papelera leaves the group the source now writes: restored
    // later, it would be a hand-made row inside it.
    const trashed = await ctx.db
      .select({ assetId: managedPortfolioHoldings.assetId })
      .from(managedPortfolioHoldings)
      .innerJoin(assets, eq(assets.id, managedPortfolioHoldings.assetId))
      .where(
        and(
          eq(managedPortfolioHoldings.portfolioId, link.portfolioId),
          isNotNull(assets.deletedAt),
        ),
      )
      .all();
    if (trashed.length > 0) {
      await ctx.db
        .delete(managedPortfolioHoldings)
        .where(
          and(
            eq(managedPortfolioHoldings.portfolioId, link.portfolioId),
            inArray(
              managedPortfolioHoldings.assetId,
              trashed.map((row) => row.assetId),
            ),
          ),
        )
        .run();
    }
    await joinConnectedManagedPortfolio(ctx, {
      addMemberHoldingIds: link.addMemberAssetIds,
      portfolioId: link.portfolioId,
      witness: link.witness,
    });
  }
}

/**
 * Refuse a product named twice in one batch, or already linked to a holding: a
 * second include of the same product would create its twin.
 */
async function assertProductsUnlinked(
  ctx: StoreContext,
  sourceId: string,
  productKeys: readonly string[],
): Promise<void> {
  if (productKeys.length === 0) return;
  if (new Set(productKeys).size !== productKeys.length) {
    throw new Error("The same product cannot be included twice in one batch.");
  }
  const linked = await ctx.db
    .select({ productKey: connectedSourceLinks.productKey })
    .from(connectedSourceLinks)
    .where(
      and(
        eq(connectedSourceLinks.sourceId, sourceId),
        inArray(connectedSourceLinks.productKey, [...productKeys]),
      ),
    )
    .all();
  if (linked.length > 0) {
    throw new Error(`Product "${linked[0]!.productKey}" is already linked to a holding.`);
  }
}

/**
 * Create the holdings and link each to its product. Each holding is born linked
 * (`connected_source_id`), so from its first row only the source can write its
 * operations.
 */
async function createLinkedHoldings(
  ctx: StoreContext,
  stores: DatedFactStores,
  sourceId: string,
  holdings: readonly ConnectedHoldingCreation[],
): Promise<void> {
  if (holdings.length === 0) return;

  for (const { holding } of holdings) {
    if (holding.kind === "investment") {
      await stores.assets.createInvestmentAsset(holding.asset);
    } else {
      await stores.assets.createManualAsset(holding.asset);
    }
  }
  const assetIds = holdings.map(({ holding }) => holding.asset.id);
  await ctx.db
    .update(assets)
    .set({ connectedSourceId: sourceId, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(inArray(assets.id, assetIds))
    .run();
  await ctx.db
    .insert(connectedSourceLinks)
    .values(
      holdings.map(({ holding, productKey }) => ({
        assetId: holding.asset.id,
        productKey,
        sourceId,
      })),
    )
    .run();
}

/**
 * Make live manual investments the source's (#1881, ADR 0115 decisions 5 and 6),
 * inside the batch: each one's manual operations leave the book for the batch's
 * provenance, its contribution plan closes today, it takes the product's identifier
 * when it had none, and it is linked. Returns, per holding, the days of the
 * operations it lost — they belong in the ripple's floor as much as the new ones.
 */
async function linkManualHoldings(
  ctx: StoreContext,
  input: {
    sourceId: string;
    batchId: string;
    today: string;
    links: readonly ConnectedHoldingLink[];
  },
): Promise<Map<string, string[]>> {
  const replacedDays = new Map<string, string[]>();
  const { links, sourceId } = input;
  if (links.length === 0) return replacedDays;

  const assetIds = links.map((link) => link.assetId);
  if (new Set(assetIds).size !== assetIds.length) {
    throw new Error("The same holding cannot be linked twice in one batch.");
  }
  const rows = await ctx.db
    .select({
      connectedSourceId: assets.connectedSourceId,
      deletedAt: assets.deletedAt,
      id: assets.id,
      type: assets.type,
    })
    .from(assets)
    .where(inArray(assets.id, assetIds))
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const assetId of assetIds) {
    const row = byId.get(assetId);
    if (
      !row ||
      row.type !== "investment" ||
      row.connectedSourceId !== null ||
      row.deletedAt !== null
    ) {
      throw new Error(
        `Holding "${assetId}" is not a live manual investment: it cannot be linked.`,
      );
    }
  }

  // A traspaso is removed whole, through the gate that owns both rows (#1393): a
  // half whose other half lives in a holding this batch does not replace would be
  // left behind as a flow nobody made. Linking both holdings at once is fine.
  const split = await readSplitTransfers(ctx, assetIds);
  if (split.length > 0) {
    const { assetId, counterpartAssetId } = split[0]!;
    throw new Error(
      `Holding "${assetId}" has half a traspaso whose other half is in "${counterpartAssetId}": ` +
        "link both at once, or undo the traspaso first.",
    );
  }

  // Every holding's rows in a fixed number of statements, never one read per link.
  const ledgers = await readHoldingLedgers(ctx, assetIds);
  const replaced = [...ledgers].flatMap(([assetId, ledger]) =>
    ledger.operations.map((operation) => ({ assetId, operation })),
  );
  for (const group of chunk(replaced, LEDGER_ROWS_PER_INSERT)) {
    await ctx.db
      .insert(factBatchReplacedOperations)
      .values(
        group.map(({ assetId, operation }) => ({
          assetId,
          batchId: input.batchId,
          operationId: operation.id,
          operationJson: JSON.stringify(operation),
        })),
      )
      .run();
  }
  // An execution that reconciled a plan occurrence goes with its row (FK cascade).
  await ctx.db
    .delete(assetOperations)
    .where(inArray(assetOperations.assetId, assetIds))
    .run();
  for (const { assetId, operation } of replaced) {
    const days = replacedDays.get(assetId) ?? [];
    days.push(operation.executedAt.slice(0, 10));
    replacedDays.set(assetId, days);
  }
  await closeHoldingPlansOnLink(ctx, assetIds, input.today);
  for (const link of links) {
    if (!link.securityId) continue;
    await ctx.db
      .update(investmentAssets)
      .set({ securityId: link.securityId.value, securityIdKind: link.securityId.kind })
      .where(
        and(
          eq(investmentAssets.assetId, link.assetId),
          isNull(investmentAssets.securityId),
        ),
      )
      .run();
  }

  await ctx.db
    .update(assets)
    .set({ connectedSourceId: sourceId, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(inArray(assets.id, assetIds))
    .run();
  await ctx.db
    .insert(connectedSourceLinks)
    .values(
      links.map((link) => ({
        assetId: link.assetId,
        productKey: link.productKey,
        sourceId,
      })),
    )
    .run();
  return replacedDays;
}

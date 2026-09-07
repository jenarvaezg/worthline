/**
 * Portfolio-level statement routing (ADR 0055).
 *
 * Parsing stays broker-only. This module groups parsed rows by **typed
 * identifier** (#1748), resolves each fund against the current portfolio, and
 * builds the confirmed import plan from the user's include/ignore decisions
 * without touching persistence.
 */

import type { LiquidityTier } from "./classification";
import type { DecimalString } from "./decimal";
import type { Instrument, InstrumentPriceProvider } from "./instrument-catalog";
import type { InvestmentOperation } from "./investment-types";
import {
  classifiedMatchKey,
  type IdentifiedByMatchKey,
  instrumentsCompatible,
  matchKeyValue,
  normalizeMatchKey,
  normalizeMatchName,
  providerSymbolMatchKey,
  rowMatchKey,
  securityIdFromMatchKey,
  securityIdMatchKey,
  symbolMatchKeyVariant,
} from "./matching-keys";
import type { CurrencyCode } from "./money";
import { netUnitsFromOperations } from "./positions";
import {
  declaredSecurityId,
  instrumentCanCarrySecurityIdKind,
  type SecurityId,
  type StoredSecurityId,
} from "./security-id";
import { planStatementMerge, type StatementMergePlan } from "./statement-merge";
import type {
  ParsedStatement,
  ParsedStatementRow,
  SkippedStatementRow,
} from "./statement-parse";
import { unitsReadAsClosed } from "./warnings";
import type { OwnershipShare } from "./workspace-types";

/**
 * A holding as CLAIMANT SELECTION reads it: identity only, no ledger.
 *
 * The split is what keeps the preview from reading the whole portfolio's
 * operations (#1748): which holdings a file could route to is decided from the
 * identity columns alone, and only those holdings' ledgers are then read — the
 * merge plan is the only thing that needs one.
 */
export interface StatementCandidateInvestment {
  assetId: string;
  name: string;
  /**
   * The holding's stored identifier pair (#1743, #1748). Its **declared** half is
   * what claims an `isin:`/`dgs:` key; the raw value is read for one other thing
   * only — whether the identifier hole is TAKEN, which is what forbids the
   * backfill offer below. A preserved value with no kind (`kind: null`, the v70
   * import exemption) claims no key and yet occupies the hole: it is something
   * nobody could read, not an invitation to write over it.
   */
  securityId?: StoredSecurityId | null;
  /**
   * The investment's provider symbol, a second matching key (#695): a CoinGecko id
   * for crypto and the finect slug of a pension plan live here, never in the
   * identifier pair, so without it every re-upload would duplicate them.
   */
  providerSymbol?: string | null;
  /**
   * What the holding is (ADR 0014). Read for the weak arm only: it is the other
   * half of the name key, and it selects which identifier kind the holding could
   * legally carry when the file offers one.
   */
  instrument?: Instrument | null;
}

/** A candidate with the ledger the merge plan is written against. */
export interface StatementPortfolioInvestment extends StatementCandidateInvestment {
  operations: InvestmentOperation[];
}

export interface StatementFundGroup {
  /**
   * The group's canonical identifier — an ISIN, a plan's DGS code, or the
   * plantilla's own key (a finect slug, a CoinGecko id). It is what the preview
   * prints and what the confirm's form fields key on; {@link key} is what it
   * MATCHES by. The field keeps its historical name to spare every consumer a
   * rename (as `ParsedStatementRow.isin` does).
   */
  isin: string;
  /**
   * The namespaced match key the group claims — `isin:…`, `dgs:N####` or
   * `sym:<símbolo>` (#1748). Two identifiers meet only inside one namespace, so a
   * plan code never matches the same characters sitting in an ISIN column or in a
   * pricing handle.
   */
  key: string;
  /**
   * The typed national identifier the group declares, when its key is one. This
   * is what a creation records and what the backfill offer would write; a `sym:`
   * group has none, because a pricing handle is not an identity.
   */
  securityId?: SecurityId;
  /** The asset type the group's rows declare, when the format carries one (#695). */
  instrument?: Instrument;
  /** A display name carried by the rows, used to prefill creation (#695) and as the weak key (#1748). */
  name?: string;
  rows: ParsedStatementRow[];
  skipped: SkippedStatementRow[];
}

/**
 * One existing investment that claims a group's identifier, with the merge the
 * group would apply **to that investment** (#1366).
 *
 * The merge plan is per claimant on purpose: it carries `toDelete` and
 * `toOverwrite` (ADR 0018 — "the file wins on the dates it covers"), so it is
 * only meaningful against one ledger. The preview renders the chosen claimant's
 * plan and the apply writes it; no claimant's operations are read for another's.
 */
export interface StatementFundClaimant {
  assetId: string;
  name: string;
  /**
   * The position holds nothing today — fully sold (ADR 0055 amendment #1348).
   * Read ONLY to rank an ambiguous identifier's claimants: new movements almost
   * never belong to a holding that was emptied. Never a gate — a closed position
   * that uniquely claims the identifier is still the right target.
   */
  closed: boolean;
  mergePlan: StatementMergePlan;
}

export interface MatchedStatementFund extends StatementFundGroup {
  bucket: "matched";
  /**
   * The best-ranked claimant. When {@link ambiguous}, this is a **default for the
   * preview to render**, never a resolution: the plan refuses to write it until
   * the user names a holding.
   */
  assetId: string;
  name: string;
  mergePlan: StatementMergePlan;
  /** Every investment claiming the identifier, best-first. Never empty. */
  claimants: StatementFundClaimant[];
  /**
   * More than one investment claims the identifier, so it names the **instrument**
   * and not the holding (#1331, on this surface #1366): the same fund at two
   * brokers is a legitimate portfolio. The choice is the user's.
   */
  ambiguous?: boolean;
  /**
   * The identifier this file brings for a holding that declares NONE (#1748).
   *
   * Present only on the weak arm: no holding claimed the group's identifier, and
   * the ones below matched by exact name + compatible instrument with their
   * identifier hole empty. It is an **offer** — the preview says «este extracto
   * trae el código N5394; tu ficha no lo declara — al confirmar, se rellena» and
   * the user confirms — never a resolution, and it never overwrites a declared
   * identifier. It is the natural cure for the «identificador ausente» health
   * signal (#1745).
   */
  offeredSecurityId?: SecurityId;
}

export interface NewStatementFund extends StatementFundGroup {
  bucket: "new";
}

export type StatementImportBucket = MatchedStatementFund | NewStatementFund;

export interface ResolveStatementImportBucketsOptions {
  replaceOpening?: (group: StatementFundGroup) => boolean;
}

export interface StatementNewInvestmentSelection {
  assetId: string;
  name: string;
  currency: CurrencyCode;
  ownership: OwnershipShare[];
  liquidityTier?: LiquidityTier;
  unitSymbol?: string;
  priceProvider?: InstrumentPriceProvider;
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
  instrument?: Instrument;
}

export type StatementFundSelection =
  | { action: "ignore"; isin: string }
  | {
      action: "include";
      isin: string;
      /**
       * Which claimant this identifier belongs to — REQUIRED when the bucket is
       * {@link MatchedStatementFund.ambiguous}, and validated against the freshly
       * re-derived claimants so a stale preview can never write (#1366). Omitted
       * for a single-claimant match and for a creation.
       */
      assetId?: string;
      creation?: StatementNewInvestmentSelection;
    };

export type StatementImportPlanFund =
  | {
      kind: "matched";
      isin: string;
      assetId: string;
      mergePlan: StatementMergePlan;
      /**
       * The identifier to write onto the holding as part of this import — the
       * accepted {@link MatchedStatementFund.offeredSecurityId} (#1748). Present
       * only when the holding's hole is empty and the kind is one its instrument
       * can carry, so the write never has to re-decide anything.
       */
      backfillSecurityId?: SecurityId;
    }
  | {
      kind: "new";
      isin: string;
      creation: StatementNewInvestmentSelection & { isin: string };
      /**
       * The typed identifier the new holding is born with, when the group carries
       * one the chosen instrument can hold (#1748). A plantilla's `N5394` creates
       * a plan that DECLARES its DGS code instead of one that merely echoes it in
       * a name — which is what lets two people with the same plan share a catalog
       * ficha (PRD #1741).
       */
      securityId?: SecurityId;
      rows: ParsedStatementRow[];
    };

export interface StatementImportPlan {
  included: StatementImportPlanFund[];
  ignored: StatementFundGroup[];
}

export function groupStatementRowsByIdentifier(
  statement: ParsedStatement,
): StatementFundGroup[] {
  const groupsByKey = new Map<string, StatementFundGroup>();

  const groupFor = (row: IdentifiedByMatchKey): StatementFundGroup | null => {
    const key = rowMatchKey(row);
    if (key === null) return null;

    let group = groupsByKey.get(key);
    if (!group) {
      const securityId = securityIdFromMatchKey(key);
      group = {
        isin: matchKeyValue(key),
        key,
        rows: [],
        skipped: [],
        ...(securityId ? { securityId } : {}),
      };
      groupsByKey.set(key, group);
    }
    return group;
  };

  for (const row of statement.rows) {
    const group = groupFor(row);
    if (!group) continue;
    group.rows.push({ ...row, isin: normalizeMatchKey(row.isin) });
    // The group's instrument/name come from its first row that carries them;
    // conflicting declarations are surfaced by findStatementTypeConflict.
    if (row.instrument && !group.instrument) group.instrument = row.instrument;
    if (row.name && !group.name) group.name = row.name;
  }

  for (const row of statement.skipped) {
    groupFor(row)?.skipped.push({ ...row, isin: normalizeMatchKey(row.isin) });
  }

  return [...groupsByKey.values()];
}

/**
 * The first identifier whose rows declare two different asset types, or null.
 * One identifier = one instrument: a mixed group would silently create with
 * whichever type happened to come first, so the caller aborts instead (#695).
 */
export function findStatementTypeConflict(groups: StatementFundGroup[]): string | null {
  for (const group of groups) {
    const declared = new Set(
      group.rows
        .map((row) => row.instrument)
        .filter((instrument): instrument is Instrument => instrument !== undefined),
    );
    if (declared.size > 1) return group.isin;
  }
  return null;
}

/** Append to a multi-map bucket, keeping portfolio order within the key. */
function claim<T>(index: Map<string, T[]>, key: string | null, investment: T): void {
  if (!key) return;
  const bucket = index.get(key);
  if (bucket) bucket.push(investment);
  else index.set(key, [investment]);
}

/**
 * Concatenate claimant lists, dropping the assets already seen and restoring
 * portfolio order — the exact-case and lowercased symbol indexes are two lookups,
 * so the order they merge in is an artifact of the key, not of the portfolio.
 */
function dedupeByAssetId<T extends StatementCandidateInvestment>(
  order: ReadonlyMap<string, number>,
  ...lists: T[][]
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const investment of lists.flat()) {
    if (seen.has(investment.assetId)) continue;
    seen.add(investment.assetId);
    merged.push(investment);
  }
  return merged.sort((a, b) => (order.get(a.assetId) ?? 0) - (order.get(b.assetId) ?? 0));
}

/** A position whose recorded ledger nets to ~zero — fully sold (#1348). */
function isClosedLedger(investment: StatementPortfolioInvestment): boolean {
  if (investment.operations.length === 0) return false;
  return unitsReadAsClosed(netUnitsFromOperations(investment.operations));
}

/**
 * Rank the claimants of an identifier, best-first — the same two honest
 * disambiguators `rankStrongClaimants` uses in the assistant's matcher (#1331),
 * and for the same reason: an order, never a resolution.
 *
 * 1. the investment whose **name** the file also carries (a file that names the
 *    live broker's fund means that one, not the old broker's closed copy);
 * 2. among the ones the name cannot tell apart, a **live** position before a
 *    closed one — new movements do not belong to a holding that was emptied.
 *
 * Ties keep portfolio order, so the default the preview renders is deterministic.
 * `sort` is stable per spec and the input is never mutated.
 */
function rankClaimants<T extends StatementCandidateInvestment>(
  group: StatementFundGroup,
  investments: T[],
  closedByAssetId: ReadonlyMap<string, boolean>,
): T[] {
  if (investments.length < 2) return investments;
  const groupName = normalizeMatchName(group.name);
  const score = (investment: T): number => {
    const nameMatches =
      groupName !== null && normalizeMatchName(investment.name) === groupName;
    return (nameMatches ? 2 : 0) + (closedByAssetId.get(investment.assetId) ? 0 : 1);
  };
  return [...investments].sort((a, b) => score(b) - score(a));
}

/** Whether the holding's identifier hole is taken — declared or merely preserved. */
function identifierHoleTaken(investment: StatementCandidateInvestment): boolean {
  return (investment.securityId?.value ?? "").trim().length > 0;
}

/**
 * The holdings that would ACCEPT the group's identifier (#1748) — the weak arm.
 *
 * A group whose identifier nobody claims may still be a holding the user already
 * has: the one whose identifier hole was never filled, which is exactly what the
 * health signal complains about. It matches on the weak key of `matching-keys` —
 * exact normalized name plus a compatible instrument, never fuzzy — and only when
 * the hole is EMPTY and the kind is one the instrument can carry. Empty is the
 * whole guard: filling a hole cannot re-price a holding as another instrument,
 * while overwriting a declared identifier could hand a later statement the wrong
 * ledger to overwrite (the #1349 asymmetry).
 */
function backfillClaimants<T extends StatementCandidateInvestment>(
  group: StatementFundGroup,
  investments: T[],
): T[] {
  const offered = group.securityId;
  const groupName = normalizeMatchName(group.name);
  if (!offered || !groupName) return [];
  return investments.filter(
    (investment) =>
      normalizeMatchName(investment.name) === groupName &&
      instrumentsCompatible(group.instrument, investment.instrument) &&
      !identifierHoleTaken(investment) &&
      instrumentCanCarrySecurityIdKind(investment.instrument, offered.kind),
  );
}

/**
 * Index the portfolio by strong key, each in its own namespace (#1748): the
 * DECLARED half of a holding's identifier pair (`isin:` / `dgs:`) and its provider
 * symbol (`sym:`, also indexed lowercased so "Bitcoin" finds "bitcoin"). A mistyped
 * pair claims no key and shows up as «sin match» rather than matching an identifier
 * of another register.
 *
 * EVERY claimant of a key is kept, in portfolio order (#1366): an identifier claimed
 * twice is a real portfolio — the same fund at two brokers — and first-wins made it
 * structurally impossible for the router to even see the second one, so it silently
 * merged into whichever was created first.
 */
function indexByStrongKey<T extends StatementCandidateInvestment>(
  investments: T[],
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const investment of investments) {
    claim(
      index,
      securityIdMatchKey(declaredSecurityId(investment.securityId)),
      investment,
    );
    const symbolKey = providerSymbolMatchKey(investment.providerSymbol);
    if (symbolKey) {
      claim(index, symbolKey, investment);
      claim(index, symbolMatchKeyVariant(symbolKey), investment);
    }
  }
  return index;
}

/**
 * The holdings that claim a group, in portfolio order, and by which arm.
 *
 * The STRONG arm is the identifier itself; the weak arm (the offer of #1748) is
 * consulted only when the identifier found nobody, so it never competes with an
 * identifier that did. Needs no ledger: this is the selection every caller runs
 * before deciding whose operations to read.
 */
function claimantsOfGroup<T extends StatementCandidateInvestment>(
  group: StatementFundGroup,
  investments: T[],
  index: Map<string, T[]>,
  order: ReadonlyMap<string, number>,
): { arm: "identifier" | "offered_name"; investments: T[] } {
  const variant = symbolMatchKeyVariant(group.key);
  const strong = dedupeByAssetId(
    order,
    index.get(group.key) ?? [],
    variant === null ? [] : (index.get(variant) ?? []),
  );
  return strong.length > 0
    ? { arm: "identifier", investments: strong }
    : { arm: "offered_name", investments: backfillClaimants(group, investments) };
}

/** Portfolio order, so a merged claimant list reads as the portfolio does. */
function portfolioOrderOf(
  investments: readonly StatementCandidateInvestment[],
): Map<string, number> {
  return new Map(investments.map((investment, index) => [investment.assetId, index]));
}

/**
 * The ids of the holdings this statement could route to — the ONLY ones whose
 * ledger the router needs (#1748).
 *
 * A caller reads this first and then reads operations for these ids alone: the
 * preview used to read the whole portfolio's operations to answer a question that
 * only the identity columns decide, and the weak arm would have widened that to
 * every holding there is.
 */
export function statementClaimantAssetIds(
  statement: ParsedStatement,
  investments: StatementCandidateInvestment[],
): string[] {
  const index = indexByStrongKey(investments);
  const order = portfolioOrderOf(investments);
  const ids = new Set<string>();
  for (const group of groupStatementRowsByIdentifier(statement)) {
    for (const investment of claimantsOfGroup(group, investments, index, order)
      .investments) {
      ids.add(investment.assetId);
    }
  }
  return [...ids];
}

export function resolveStatementImportBuckets(
  statement: ParsedStatement,
  investments: StatementPortfolioInvestment[],
  options: ResolveStatementImportBucketsOptions = {},
): StatementImportBucket[] {
  const investmentsByKey = indexByStrongKey(investments);
  const portfolioOrder = portfolioOrderOf(investments);
  // Derived once per portfolio, not once per comparison inside a sort.
  const closedByAssetId = new Map(
    investments.map((investment) => [investment.assetId, isClosedLedger(investment)]),
  );

  return groupStatementRowsByIdentifier(statement).map((group) => {
    const claimed = claimantsOfGroup(
      group,
      investments,
      investmentsByKey,
      portfolioOrder,
    );
    const claimants = rankClaimants(group, claimed.investments, closedByAssetId);

    if (claimants.length === 0) {
      return { ...group, bucket: "new" };
    }

    const replaceOpening = options.replaceOpening?.(group) ?? true;
    const planned: StatementFundClaimant[] = claimants.map((investment) => ({
      assetId: investment.assetId,
      closed: closedByAssetId.get(investment.assetId) === true,
      mergePlan: planStatementMerge(group.rows, investment.operations, {
        replaceOpening,
      }),
      name: investment.name,
    }));
    const best = planned[0]!;

    return {
      ...group,
      assetId: best.assetId,
      bucket: "matched",
      claimants: planned,
      mergePlan: best.mergePlan,
      name: best.name,
      ...(claimed.arm === "offered_name" && group.securityId
        ? { offeredSecurityId: group.securityId }
        : {}),
      ...(planned.length > 1 ? { ambiguous: true } : {}),
    };
  });
}

/**
 * The first identifier an included selection leaves unresolved, or null (#1366).
 *
 * Unresolved means the selection does not name exactly one claimant the router
 * just re-derived: an ambiguous identifier with no `assetId`, or an `assetId` no
 * claimant carries — which is what a preview built against a portfolio that has
 * since changed would post. The surfaces call this before building the plan so
 * the user reads a sentence instead of a stack trace; the plan itself throws on
 * the same condition, as the invariant of last resort.
 */
export function findUnresolvedStatementChoice(
  buckets: StatementImportBucket[],
  selections: StatementFundSelection[],
): string | null {
  const bucketByIsin = new Map(buckets.map((bucket) => [bucket.isin, bucket]));

  for (const selection of selections) {
    if (selection.action !== "include") continue;
    const bucket = bucketByIsin.get(selectionIdentifier(selection.isin));
    if (!bucket || bucket.bucket !== "matched") continue;
    if (resolveChosenClaimant(bucket, selection.assetId) === null) return bucket.isin;
  }

  return null;
}

/**
 * A selection names a bucket by the identifier the preview printed, so it is
 * canonicalized the same way the group was — through the classifier, not through
 * the loose key normalizer, or `n-5394` posted back would find no bucket.
 */
function selectionIdentifier(isin: string): string {
  const key = classifiedMatchKey(isin);
  return key === null ? "" : matchKeyValue(key);
}

/**
 * The claimant a selection names, or null when the choice is missing or stale.
 * A single-claimant match needs no choice; an ambiguous one is never resolved by
 * order (that was the bug).
 */
function resolveChosenClaimant(
  bucket: MatchedStatementFund,
  assetId: string | undefined,
): StatementFundClaimant | null {
  if (assetId === undefined) {
    return bucket.ambiguous ? null : (bucket.claimants[0] ?? null);
  }
  return bucket.claimants.find((claimant) => claimant.assetId === assetId) ?? null;
}

export function buildStatementImportPlan(
  buckets: StatementImportBucket[],
  selections: StatementFundSelection[],
): StatementImportPlan {
  const selectionByIsin = new Map(
    selections.map((selection) => [selectionIdentifier(selection.isin), selection]),
  );
  const included: StatementImportPlanFund[] = [];
  const ignored: StatementFundGroup[] = [];

  for (const bucket of buckets) {
    const selection = selectionByIsin.get(bucket.isin);

    if (!selection || selection.action === "ignore") {
      ignored.push({
        isin: bucket.isin,
        key: bucket.key,
        rows: bucket.rows,
        skipped: bucket.skipped,
        ...(bucket.securityId ? { securityId: bucket.securityId } : {}),
      });
      continue;
    }

    if (bucket.bucket === "matched") {
      const chosen = resolveChosenClaimant(bucket, selection.assetId);
      if (!chosen) {
        throw new Error(
          `Unresolved holding choice for identifier ${bucket.isin}: ${bucket.claimants.length} investments claim it.`,
        );
      }
      included.push({
        assetId: chosen.assetId,
        isin: bucket.isin,
        kind: "matched",
        mergePlan: chosen.mergePlan,
        ...(bucket.offeredSecurityId
          ? { backfillSecurityId: bucket.offeredSecurityId }
          : {}),
      });
      continue;
    }

    if (!selection.creation) {
      throw new Error(`Missing creation details for identifier ${bucket.isin}.`);
    }

    // The identity a creation is born with is written only when the instrument the
    // user is creating could carry it (#1453): an ISIN group turned into a crypto
    // holding records no ISIN, it does not record a wrong one.
    const born =
      bucket.securityId &&
      instrumentCanCarrySecurityIdKind(
        selection.creation.instrument,
        bucket.securityId.kind,
      )
        ? bucket.securityId
        : undefined;

    included.push({
      creation: { ...selection.creation, isin: bucket.isin },
      isin: bucket.isin,
      kind: "new",
      rows: bucket.rows,
      ...(born ? { securityId: born } : {}),
    });
  }

  return { ignored, included };
}

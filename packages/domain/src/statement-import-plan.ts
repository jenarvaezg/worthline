/**
 * Portfolio-level statement routing (ADR 0055).
 *
 * Parsing stays broker-only. This module groups parsed rows by ISIN, resolves each
 * fund against the current portfolio, and builds the confirmed import plan from
 * the user's include/ignore decisions without touching persistence.
 */

import type { LiquidityTier } from "./classification";
import type { DecimalString } from "./decimal";
import type { Instrument, InstrumentPriceProvider } from "./instrument-catalog";
import type { InvestmentOperation } from "./investment-types";
import { isIsinShaped, normalizeMatchKey, normalizeMatchName } from "./matching-keys";
import type { CurrencyCode } from "./money";
import { netUnitsFromOperations } from "./positions";
import { planStatementMerge, type StatementMergePlan } from "./statement-merge";
import type {
  ParsedStatement,
  ParsedStatementRow,
  SkippedStatementRow,
} from "./statement-parse";
import { unitsReadAsClosed } from "./warnings";
import type { OwnershipShare } from "./workspace-types";

export { isIsinShaped };

export interface StatementPortfolioInvestment {
  assetId: string;
  name: string;
  isin?: string | null;
  /**
   * The investment's provider symbol, a second matching key (#695): plantilla
   * identifiers for pension plans (Finect code) and crypto (CoinGecko id) live
   * here, never in `isin`, so without it every re-upload would duplicate them.
   */
  providerSymbol?: string | null;
  operations: InvestmentOperation[];
}

export interface StatementFundGroup {
  /** The group's identifier — an ISIN for broker rows; any key for plantilla. */
  isin: string;
  /** The asset type the group's rows declare, when the format carries one (#695). */
  instrument?: Instrument;
  /** A display name carried by the rows, used only to prefill creation (#695). */
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
    }
  | {
      kind: "new";
      isin: string;
      creation: StatementNewInvestmentSelection & { isin: string };
      rows: ParsedStatementRow[];
    };

export interface StatementImportPlan {
  included: StatementImportPlanFund[];
  ignored: StatementFundGroup[];
}

const normalizeIsin = normalizeMatchKey;

export function groupStatementRowsByIsin(
  statement: ParsedStatement,
): StatementFundGroup[] {
  const groupsByIsin = new Map<string, StatementFundGroup>();

  const groupFor = (isin: string | null): StatementFundGroup | null => {
    const normalized = normalizeIsin(isin);
    if (!normalized) return null;

    let group = groupsByIsin.get(normalized);
    if (!group) {
      group = { isin: normalized, rows: [], skipped: [] };
      groupsByIsin.set(normalized, group);
    }
    return group;
  };

  for (const row of statement.rows) {
    const group = groupFor(row.isin);
    if (!group) continue;
    group.rows.push({ ...row, isin: normalizeIsin(row.isin) });
    // The group's instrument/name come from its first row that carries them;
    // conflicting declarations are surfaced by findStatementTypeConflict.
    if (row.instrument && !group.instrument) group.instrument = row.instrument;
    if (row.name && !group.name) group.name = row.name;
  }

  for (const row of statement.skipped) {
    groupFor(row.isin)?.skipped.push({ ...row, isin: normalizeIsin(row.isin) });
  }

  return [...groupsByIsin.values()];
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
function claim(
  index: Map<string, StatementPortfolioInvestment[]>,
  key: string | null,
  investment: StatementPortfolioInvestment,
): void {
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
function dedupeByAssetId(
  order: ReadonlyMap<string, number>,
  ...lists: StatementPortfolioInvestment[][]
): StatementPortfolioInvestment[] {
  const seen = new Set<string>();
  const merged: StatementPortfolioInvestment[] = [];
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
function rankClaimants(
  group: StatementFundGroup,
  investments: StatementPortfolioInvestment[],
): StatementPortfolioInvestment[] {
  if (investments.length < 2) return investments;
  const groupName = normalizeMatchName(group.name);
  const score = (investment: StatementPortfolioInvestment): number => {
    const nameMatches =
      groupName !== null && normalizeMatchName(investment.name) === groupName;
    return (nameMatches ? 2 : 0) + (isClosedLedger(investment) ? 0 : 1);
  };
  return [...investments].sort((a, b) => score(b) - score(a));
}

export function resolveStatementImportBuckets(
  statement: ParsedStatement,
  investments: StatementPortfolioInvestment[],
  options: ResolveStatementImportBucketsOptions = {},
): StatementImportBucket[] {
  // Two matching keys per investment (#695): its ISIN and its provider symbol
  // (Finect code / CoinGecko id — how plantilla identifies plans and crypto).
  // The symbol also indexes case-insensitively so "Bitcoin" finds "bitcoin".
  //
  // EVERY claimant of a key is kept, in portfolio order (#1366): an identifier
  // claimed twice is a real portfolio — the same fund at two brokers — and
  // first-wins made it structurally impossible for the router to even see the
  // second one, so it silently merged into whichever was created first.
  const investmentsByKey = new Map<string, StatementPortfolioInvestment[]>();
  const portfolioOrder = new Map(
    investments.map((investment, index) => [investment.assetId, index]),
  );
  for (const investment of investments) {
    claim(investmentsByKey, normalizeIsin(investment.isin), investment);
    const symbol = (investment.providerSymbol ?? "").trim();
    if (symbol) {
      claim(investmentsByKey, symbol, investment);
      if (symbol.toLowerCase() !== symbol) {
        claim(investmentsByKey, symbol.toLowerCase(), investment);
      }
    }
  }

  return groupStatementRowsByIsin(statement).map((group) => {
    const claimants = rankClaimants(
      group,
      dedupeByAssetId(
        portfolioOrder,
        investmentsByKey.get(group.isin) ?? [],
        investmentsByKey.get(group.isin.toLowerCase()) ?? [],
      ),
    );

    if (claimants.length === 0) {
      return { ...group, bucket: "new" };
    }

    const replaceOpening = options.replaceOpening?.(group) ?? true;
    const planned: StatementFundClaimant[] = claimants.map((investment) => ({
      assetId: investment.assetId,
      closed: isClosedLedger(investment),
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
    const bucket = bucketByIsin.get(normalizeIsin(selection.isin) ?? selection.isin);
    if (!bucket || bucket.bucket !== "matched") continue;
    if (resolveChosenClaimant(bucket, selection.assetId) === null) return bucket.isin;
  }

  return null;
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
    selections.map((selection) => [normalizeIsin(selection.isin), selection]),
  );
  const included: StatementImportPlanFund[] = [];
  const ignored: StatementFundGroup[] = [];

  for (const bucket of buckets) {
    const selection = selectionByIsin.get(bucket.isin);

    if (!selection || selection.action === "ignore") {
      ignored.push({ isin: bucket.isin, rows: bucket.rows, skipped: bucket.skipped });
      continue;
    }

    if (bucket.bucket === "matched") {
      const chosen = resolveChosenClaimant(bucket, selection.assetId);
      if (!chosen) {
        throw new Error(
          `Unresolved holding choice for ISIN ${bucket.isin}: ${bucket.claimants.length} investments claim it.`,
        );
      }
      included.push({
        assetId: chosen.assetId,
        isin: bucket.isin,
        kind: "matched",
        mergePlan: chosen.mergePlan,
      });
      continue;
    }

    if (!selection.creation) {
      throw new Error(`Missing creation details for ISIN ${bucket.isin}.`);
    }

    included.push({
      creation: { ...selection.creation, isin: bucket.isin },
      isin: bucket.isin,
      kind: "new",
      rows: bucket.rows,
    });
  }

  return { ignored, included };
}

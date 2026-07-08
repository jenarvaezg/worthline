/**
 * Portfolio-level statement routing (ADR 0055).
 *
 * Parsing stays broker-only. This module groups parsed rows by ISIN, resolves each
 * fund against the current portfolio, and builds the confirmed import plan from
 * the user's include/ignore decisions without touching persistence.
 */

import type { DecimalString } from "./decimal";
import type { Instrument, InstrumentPriceProvider } from "./instrument-catalog";
import type { InvestmentOperation } from "./investment-types";
import type { LiquidityTier } from "./classification";
import type { CurrencyCode } from "./money";
import type { OwnershipShare } from "./workspace-types";
import { planStatementMerge, type StatementMergePlan } from "./statement-merge";
import type {
  ParsedStatement,
  ParsedStatementRow,
  SkippedStatementRow,
} from "./statement-parse";

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

export interface MatchedStatementFund extends StatementFundGroup {
  bucket: "matched";
  assetId: string;
  name: string;
  mergePlan: StatementMergePlan;
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

const ISIN_SHAPE = /^[A-Za-z]{2}[A-Za-z0-9]{9}[0-9]$/;

/**
 * Normalize a statement identifier: uppercase only when it has ISIN shape.
 * Plantilla identifiers (#695) include CoinGecko ids, which are lowercase by
 * contract — uppercasing "bitcoin" would break both grouping and matching.
 */
function normalizeIsin(isin: string | null | undefined): string | null {
  const trimmed = (isin ?? "").trim();
  if (!trimmed) return null;
  return ISIN_SHAPE.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

/** Whether an identifier can be persisted as the created asset's ISIN. */
export function isIsinShaped(identifier: string): boolean {
  return ISIN_SHAPE.test(identifier.trim());
}

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

export function resolveStatementImportBuckets(
  statement: ParsedStatement,
  investments: StatementPortfolioInvestment[],
  options: ResolveStatementImportBucketsOptions = {},
): StatementImportBucket[] {
  // Two matching keys per investment (#695): its ISIN and its provider symbol
  // (Finect code / CoinGecko id — how plantilla identifies plans and crypto).
  // The symbol also indexes case-insensitively so "Bitcoin" finds "bitcoin".
  const investmentByKey = new Map<string, StatementPortfolioInvestment>();
  const claim = (key: string | null, investment: StatementPortfolioInvestment) => {
    if (key && !investmentByKey.has(key)) investmentByKey.set(key, investment);
  };
  for (const investment of investments) {
    claim(normalizeIsin(investment.isin), investment);
    const symbol = (investment.providerSymbol ?? "").trim();
    if (symbol) {
      claim(symbol, investment);
      claim(symbol.toLowerCase(), investment);
    }
  }

  return groupStatementRowsByIsin(statement).map((group) => {
    const investment =
      investmentByKey.get(group.isin) ?? investmentByKey.get(group.isin.toLowerCase());

    if (!investment) {
      return { ...group, bucket: "new" };
    }

    return {
      ...group,
      assetId: investment.assetId,
      bucket: "matched",
      mergePlan: planStatementMerge(group.rows, investment.operations, {
        replaceOpening: options.replaceOpening?.(group) ?? true,
      }),
      name: investment.name,
    };
  });
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
      included.push({
        assetId: bucket.assetId,
        isin: bucket.isin,
        kind: "matched",
        mergePlan: bucket.mergePlan,
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

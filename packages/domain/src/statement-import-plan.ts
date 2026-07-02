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
  operations: InvestmentOperation[];
}

export interface StatementFundGroup {
  isin: string;
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

function normalizeIsin(isin: string | null | undefined): string | null {
  const trimmed = (isin ?? "").trim();
  return trimmed ? trimmed.toUpperCase() : null;
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
    groupFor(row.isin)?.rows.push({ ...row, isin: normalizeIsin(row.isin) });
  }

  for (const row of statement.skipped) {
    groupFor(row.isin)?.skipped.push({ ...row, isin: normalizeIsin(row.isin) });
  }

  return [...groupsByIsin.values()];
}

export function resolveStatementImportBuckets(
  statement: ParsedStatement,
  investments: StatementPortfolioInvestment[],
): StatementImportBucket[] {
  const investmentByIsin = new Map<string, StatementPortfolioInvestment>();
  for (const investment of investments) {
    const isin = normalizeIsin(investment.isin);
    if (isin && !investmentByIsin.has(isin)) {
      investmentByIsin.set(isin, investment);
    }
  }

  return groupStatementRowsByIsin(statement).map((group) => {
    const investment = investmentByIsin.get(group.isin);

    if (!investment) {
      return { ...group, bucket: "new" };
    }

    return {
      ...group,
      assetId: investment.assetId,
      bucket: "matched",
      mergePlan: planStatementMerge(group.rows, investment.operations),
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

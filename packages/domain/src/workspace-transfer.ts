/**
 * Workspace export/import file contract (ADR 0010).
 *
 * A `WorkspaceExport` is the versioned JSON document that captures an entire
 * workspace: live state, frozen snapshot history, the papelera, and the price
 * cache. It is the manual stand-in for backup/sync in an app with no cloud.
 * The audit log is deliberately not a section.
 *
 * The document is untrusted input at a system boundary — it may be produced by
 * an external script, not just by the app — so importers must validate it
 * (structure plus domain invariants) before any write. A `version` mismatch is
 * rejected outright: there is intentionally no format-migration ladder.
 */

import type { EarlyRepaymentMode } from "./amortization";
import type { LiquidityTier } from "./classification";
import type { DecimalString } from "./decimal";
import type { ValuationMethod } from "./holding-valuation";
import type { Instrument } from "./instrument-catalog";
import type { CurrencyCode, MoneyMinor } from "./money";
import type { AssetPrice, InvestmentPriceProvider } from "./prices";
import type { SnapshotHoldingRow } from "./snapshot-holdings";
import type { WarningOverride } from "./warnings";
import type { FireScopeConfig } from "./fire";
import type { InvestmentOperation } from "./investment-types";
import type { NetWorthSnapshot } from "./snapshot-types";
import type {
  AssetType,
  DebtModel,
  LiabilityType,
  Member,
  MemberGroup,
  OwnershipShare,
  WorkspaceMode,
} from "./workspace-types";

/**
 * Bumped to 2 for the full-holding-model format (ADR 0015, #155): the v1 shape
 * silently dropped every dated structural fact (appreciation rate, valuation
 * anchors, debt model, amortization plan, rate revisions, early repayments,
 * balance anchors). No production v1 exports exist, so v1 is abandoned with no
 * converter — version 1 is rejected outright like any other mismatch.
 */
export const EXPORT_VERSION = 2;

/** Workspace-level configuration carried by the file. */
export interface ExportedWorkspaceConfig {
  mode: WorkspaceMode;
  /** Always EUR in the MVP — anything else is rejected on import. */
  baseCurrency: CurrencyCode;
}

/** Investment metadata attached to an asset of type "investment". */
export interface ExportedInvestmentMeta {
  unitSymbol?: string;
  isin?: string;
  priceProvider?: InvestmentPriceProvider;
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
  manualPricedAt?: string;
}

/**
 * One housing valuation anchor (ADR 0015, #155): a market appraisal (total
 * truth) or an improvement (increment) layered on the appreciation curve. Its
 * id is carried so a restore preserves it verbatim.
 */
export interface ExportedValuationAnchor {
  id: string;
  /** Integer minor units. TOTAL when adjustsPriorCurve, INCREMENT otherwise. */
  valueMinor: number;
  /** YYYY-MM-DD. */
  valuationDate: string;
  /** True for a market appraisal (total truth), false for an improvement. */
  adjustsPriorCurve: boolean;
}

/** A scheduled interest-rate change on an amortization plan (ADR 0015, #155). */
export interface ExportedInterestRateRevision {
  id: string;
  /** YYYY-MM-DD the new rate takes effect from. */
  revisionDate: string;
  /** Decimal-string annual rate, e.g. "0.031". */
  newAnnualInterestRate: DecimalString;
}

/** A lump-sum early repayment against an amortization plan (ADR 0015, #155). */
export interface ExportedEarlyRepayment {
  id: string;
  /** YYYY-MM-DD the repayment is made. */
  repaymentDate: string;
  /** Principal repaid, integer minor units. */
  amountMinor: number;
  /** reduce-payment keeps the term; reduce-term keeps the cuota. */
  mode: EarlyRepaymentMode;
}

/**
 * The French-amortization plan of an amortizable debt (ADR 0015, #155): its
 * declared conditions plus the dated facts that reshape its schedule — rate
 * revisions and early repayments — which hang off the plan by id.
 */
export interface ExportedAmortizationPlan {
  id: string;
  /** Initial borrowed capital, integer minor units. */
  initialCapitalMinor: number;
  /** Decimal-string annual interest rate, e.g. "0.025". */
  annualInterestRate: DecimalString;
  /** Loan term in whole months (payments counted from the first payment). */
  termMonths: number;
  /** Disbursement date (firma / devengo), YYYY-MM-DD (ADR 0019). */
  disbursementDate: string;
  /** First-payment date, YYYY-MM-DD (ADR 0019). */
  firstPaymentDate: string;
  interestRateRevisions: ExportedInterestRateRevision[];
  earlyRepayments: ExportedEarlyRepayment[];
}

/** A declared balance of a revolving/informal liability on a date (ADR 0015, #155). */
export interface ExportedBalanceAnchor {
  id: string;
  /** Total owed on that date, integer minor units (interest already included). */
  balanceMinor: number;
  /** YYYY-MM-DD the balance applies on. */
  anchorDate: string;
}

/**
 * One asset in the file. Hand-valued kinds carry `currentValue`; investments
 * never do — their value is derived from operations and prices (ADR 0006), so
 * a hand-valued investment is rejected on import. `deletedAt` appears only on
 * entries inside the trash section.
 *
 * Structural facts (ADR 0015, #155) — `valuationMethod`, `annualAppreciationRate`,
 * and `valuationAnchors` — are carried so an appreciating property survives a
 * round-trip with its revaluation curve intact instead of flattening to a line.
 */
export interface ExportedAsset {
  id: string;
  name: string;
  type: AssetType;
  currency: CurrencyCode;
  currentValue?: MoneyMinor;
  liquidityTier: LiquidityTier;
  isPrimaryResidence?: boolean;
  /** What the asset is (ADR 0014, #149); derived from type on import when absent. */
  instrument?: Instrument;
  /** How the asset's value evolves (ADR 0014/0015); derived from type on import when absent. */
  valuationMethod?: ValuationMethod;
  /** Decimal-string annual appreciation rate (e.g. "0.03"); only meaningful for real estate. */
  annualAppreciationRate?: DecimalString;
  /** Housing valuation anchors (market appraisals + improvements); ordered by date. */
  valuationAnchors?: ExportedValuationAnchor[];
  ownership: OwnershipShare[];
  investment?: ExportedInvestmentMeta;
  deletedAt?: string;
}

/**
 * One liability in the file. `deletedAt` appears only inside the trash section.
 *
 * Structural facts (ADR 0015, #155) — `valuationMethod`, `debtModel`,
 * `amortizationPlan` (with its revisions + early repayments), and
 * `balanceAnchors` — are carried so an amortizing debt survives a round-trip
 * with its schedule intact instead of flattening to a line.
 */
export interface ExportedLiability {
  id: string;
  name: string;
  type: LiabilityType;
  currency: CurrencyCode;
  currentBalance: MoneyMinor;
  /** What the liability is (ADR 0014, #149); derived from type on import when absent. */
  instrument?: Instrument;
  /** How the liability's balance evolves (ADR 0014/0015); derived from debt model on import when absent. */
  valuationMethod?: ValuationMethod;
  /** How the liability is modelled for historical reconstruction; null/absent means manual balance. */
  debtModel?: DebtModel;
  /** The amortization plan (with its revisions + early repayments) when debtModel is amortizable. */
  amortizationPlan?: ExportedAmortizationPlan;
  /** Declared balance anchors when debtModel is revolving/informal; ordered by date. */
  balanceAnchors?: ExportedBalanceAnchor[];
  ownership: OwnershipShare[];
  associatedAssetId?: string;
  deletedAt?: string;
}

/**
 * A frozen snapshot plus the valued portfolio behind its figures (ADR 0008).
 * Holdings may be empty for captures that predate snapshot holdings; when
 * present they must reconcile exactly with the snapshot's headline figures.
 */
export interface ExportedSnapshot extends NetWorthSnapshot {
  holdings: SnapshotHoldingRow[];
}

/** The papelera: soft-deleted holdings awaiting restore or hard delete. */
export interface ExportedTrash {
  assets: ExportedAsset[];
  liabilities: ExportedLiability[];
}

/** Every section of the document, without the version stamp. */
export interface WorkspaceExportData {
  workspace: ExportedWorkspaceConfig;
  members: Member[];
  groups: MemberGroup[];
  assets: ExportedAsset[];
  liabilities: ExportedLiability[];
  operations: InvestmentOperation[];
  warningOverrides: WarningOverride[];
  fireConfig: Record<string, FireScopeConfig>;
  snapshots: ExportedSnapshot[];
  trash: ExportedTrash;
  priceCache: AssetPrice[];
}

/** The versioned export document — the on-disk JSON shape. */
export interface WorkspaceExport extends WorkspaceExportData {
  version: typeof EXPORT_VERSION;
}

/**
 * Per-section counts of an export document, for the import preview: what the
 * user is about to replace their workspace with, before anything is written.
 */
export interface WorkspaceExportSummary {
  members: number;
  groups: number;
  assets: number;
  liabilities: number;
  operations: number;
  snapshots: number;
  trashedAssets: number;
  trashedLiabilities: number;
  warningOverrides: number;
  priceCacheEntries: number;
  fireConfigScopes: number;
}

/** Count every section of an (already validated) export document. */
export function summarizeWorkspaceExport(doc: WorkspaceExport): WorkspaceExportSummary {
  return {
    members: doc.members.length,
    groups: doc.groups.length,
    assets: doc.assets.length,
    liabilities: doc.liabilities.length,
    operations: doc.operations.length,
    snapshots: doc.snapshots.length,
    trashedAssets: doc.trash.assets.length,
    trashedLiabilities: doc.trash.liabilities.length,
    warningOverrides: doc.warningOverrides.length,
    priceCacheEntries: doc.priceCache.length,
    fireConfigScopes: Object.keys(doc.fireConfig).length,
  };
}

/** Build the versioned export document from the in-memory section data. */
export function serializeWorkspaceExport(data: WorkspaceExportData): WorkspaceExport {
  return {
    version: EXPORT_VERSION,
    workspace: data.workspace,
    members: data.members,
    groups: data.groups,
    assets: data.assets,
    liabilities: data.liabilities,
    operations: data.operations,
    warningOverrides: data.warningOverrides,
    fireConfig: data.fireConfig,
    snapshots: data.snapshots,
    trash: data.trash,
    priceCache: data.priceCache,
  };
}

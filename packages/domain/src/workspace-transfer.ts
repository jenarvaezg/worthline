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

import type { LiquidityTier } from "./classification";
import type { DecimalString } from "./decimal";
import type { CurrencyCode, MoneyMinor } from "./money";
import type { AssetPrice } from "./prices";
import type { SnapshotHoldingRow } from "./snapshot-holdings";
import type { WarningOverride } from "./warnings";
import type {
  AssetType,
  FireScopeConfig,
  InvestmentOperation,
  LiabilityType,
  Member,
  MemberGroup,
  NetWorthSnapshot,
  OwnershipShare,
  WorkspaceMode,
} from "./index";

export const EXPORT_VERSION = 1;

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
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
  manualPricedAt?: string;
}

/**
 * One asset in the file. Hand-valued kinds carry `currentValue`; investments
 * never do — their value is derived from operations and prices (ADR 0006), so
 * a hand-valued investment is rejected on import. `deletedAt` appears only on
 * entries inside the trash section.
 */
export interface ExportedAsset {
  id: string;
  name: string;
  type: AssetType;
  currency: CurrencyCode;
  currentValue?: MoneyMinor;
  liquidityTier: LiquidityTier;
  isPrimaryResidence?: boolean;
  ownership: OwnershipShare[];
  investment?: ExportedInvestmentMeta;
  deletedAt?: string;
}

/** One liability in the file. `deletedAt` appears only inside the trash section. */
export interface ExportedLiability {
  id: string;
  name: string;
  type: LiabilityType;
  currency: CurrencyCode;
  currentBalance: MoneyMinor;
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

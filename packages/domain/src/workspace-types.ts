import type { CurrencyCode, MoneyMinor } from "./money";
import { assertMinorInteger } from "./money";
import type { LiquidityTier } from "./liquidity-tier";
import type { Instrument } from "./instrument-catalog";
import { defaultInstrumentForAssetType } from "./instrument-catalog";
import type { DomainResult, DomainViolation } from "./domain-result";

export type WorkspaceMode = "individual" | "household";

/**
 * A member's appetite for volatility (PRD #421, #423). Drives the equity/bond
 * allocation the assistant suggests; stored per member because partners can
 * differ. Free of any amount — pure preference.
 */
export type RiskTolerance = "conservative" | "moderate" | "aggressive";

export interface Member {
  id: string;
  name: string;
  disabledAt?: string;
  /**
   * Member profile (PRD #421, #423): the reference age for FIRE projections is
   * derived from `birthYear`; `fiscalCountry` (ISO 3166-1 alpha-2, e.g. "ES")
   * lets the assistant avoid tax-inefficient suggestions; `riskTolerance` shapes
   * allocation advice. All optional — a member may have none set. PII: exposed
   * only through the authenticated MCP, never a public endpoint.
   */
  birthYear?: number;
  fiscalCountry?: string;
  riskTolerance?: RiskTolerance;
}

export interface MemberGroup {
  id: string;
  name: string;
  memberIds: string[];
}

export interface Workspace {
  baseCurrency: CurrencyCode;
  mode: WorkspaceMode;
  members: Member[];
  groups: MemberGroup[];
}

export function createWorkspace(input: {
  mode: WorkspaceMode;
  members: Member[];
  groups?: MemberGroup[];
  baseCurrency?: CurrencyCode;
}): Workspace {
  if (input.members.length === 0) {
    throw new Error("Workspace requires at least one member.");
  }

  const activeMemberIds = new Set(
    input.members.filter((member) => !member.disabledAt).map((member) => member.id),
  );

  for (const group of input.groups ?? []) {
    for (const memberId of group.memberIds) {
      if (!activeMemberIds.has(memberId)) {
        throw new Error(`Group ${group.id} references unknown member ${memberId}.`);
      }
    }
  }

  return {
    baseCurrency: input.baseCurrency ?? "EUR",
    groups: input.groups ?? [],
    members: input.members,
    mode: input.mode,
  };
}

export type AssetType = "cash" | "manual" | "real_estate" | "investment";

export interface OwnershipShare {
  memberId: string;
  shareBps: number;
}

export interface ManualAsset {
  id: string;
  name: string;
  type: AssetType;
  currency: CurrencyCode;
  currentValue: MoneyMinor;
  liquidityTier: LiquidityTier;
  ownership: OwnershipShare[];
  isPrimaryResidence: boolean;
  /**
   * What the asset is (ADR 0014, #149). Optional on the type for the many
   * in-memory fixtures that predate it; `createManualAsset` always populates it
   * (deriving from `type`/`isPrimaryResidence` when not given), and reads source
   * it from the backfilled column. `instrumentOfAsset` derives it when absent.
   */
  instrument?: Instrument;
  /**
   * The investment's price-provider lookup key (ADR 0055). Only meaningful for a
   * `derived` (investment) holding; absent on every other type. Read-only
   * metadata for the warnings system (`MISSING_PROVIDER_SYMBOL`) — never a figure
   * the math reads. Optional on the type for the many in-memory fixtures that
   * predate it, like `instrument` above.
   */
  providerSymbol?: string;
  /**
   * The connected source this asset materializes a rung of (ADR 0016/0021, #248);
   * absent for a hand-maintained holding. Read-only metadata for the warnings
   * system (`MISSING_PROVIDER_SYMBOL`) — a connected-source holding is priced by
   * its source's own sync and will never carry a `providerSymbol` (#685 bug).
   */
  connectedSourceId?: string;
}

export type LiabilityType = "mortgage" | "debt";

/**
 * How a liability is modelled for historical reconstruction (PRD #109, slice 7).
 * `amortizable` = a French-amortization loan with a plan; `revolving` = a credit
 * line; `informal` = an ad-hoc debt. Null on a liability means no model is
 * declared and the current balance is used as-is (no derived history).
 */
export type DebtModel = "amortizable" | "revolving" | "informal";

export interface Liability {
  id: string;
  name: string;
  type: LiabilityType;
  currency: CurrencyCode;
  currentBalance: MoneyMinor;
  ownership: OwnershipShare[];
  associatedAssetId?: string;
}

export interface CreateManualAssetInput {
  id: string;
  name: string;
  type: AssetType;
  currency: CurrencyCode;
  currentValueMinor: number;
  liquidityTier: LiquidityTier;
  ownership: OwnershipShare[];
  isPrimaryResidence?: boolean;
  /** What the asset is (ADR 0014, #149); derived from `type` when not given. */
  instrument?: Instrument;
  /** The investment's price-provider lookup key (ADR 0055), when known. */
  providerSymbol?: string;
  /** The connected source this asset materializes a rung of (ADR 0016/0021, #248), when known. */
  connectedSourceId?: string;
}

export interface CreateLiabilityInput {
  id: string;
  name: string;
  type: LiabilityType;
  currency: CurrencyCode;
  balanceMinor: number;
  ownership: OwnershipShare[];
  associatedAssetId?: string;
}

export function createManualAsset(
  workspace: Workspace,
  input: CreateManualAssetInput,
): ManualAsset {
  assertCurrency(input.currency);
  assertMinorInteger(input.currentValueMinor);
  assertOwnership(workspace, input.ownership, {
    allowKnownPartial: input.type === "real_estate",
  });

  return {
    currency: input.currency,
    currentValue: {
      amountMinor: input.currentValueMinor,
      currency: input.currency,
    },
    id: input.id,
    instrument:
      input.instrument ??
      defaultInstrumentForAssetType(input.type, input.isPrimaryResidence ?? false),
    isPrimaryResidence: input.isPrimaryResidence ?? false,
    liquidityTier: input.liquidityTier,
    name: input.name,
    ownership: input.ownership,
    type: input.type,
    ...(input.providerSymbol ? { providerSymbol: input.providerSymbol } : {}),
    ...(input.connectedSourceId ? { connectedSourceId: input.connectedSourceId } : {}),
  };
}

export function createLiability(
  workspace: Workspace,
  input: CreateLiabilityInput,
  options: { allowKnownPartial?: boolean } = {},
): Liability {
  assertCurrency(input.currency);
  assertMinorInteger(input.balanceMinor);
  assertOwnership(workspace, input.ownership, options);

  return {
    currency: input.currency,
    currentBalance: {
      amountMinor: input.balanceMinor,
      currency: input.currency,
    },
    id: input.id,
    name: input.name,
    ownership: input.ownership,
    type: input.type,
    ...(input.associatedAssetId ? { associatedAssetId: input.associatedAssetId } : {}),
  };
}

/**
 * Safe variant of `createManualAsset`: returns a `DomainResult` instead of
 * throwing when the ownership split does not total 10 000 bps.
 * Programmer-error paths (unknown member, non-integer bps, bad currency) still
 * throw — only the ownership-split rule becomes data.
 */
export function createManualAssetSafe(
  workspace: Workspace,
  input: CreateManualAssetInput,
): DomainResult<ManualAsset> {
  assertCurrency(input.currency);
  assertMinorInteger(input.currentValueMinor);

  const splitViolation = checkOwnershipSplit(workspace, input.ownership, {
    allowKnownPartial: input.type === "real_estate",
  });

  if (splitViolation) {
    return { ok: false, violations: [splitViolation] };
  }

  return { ok: true, value: createManualAsset(workspace, input) };
}

/**
 * Safe variant of `createLiability`: returns a `DomainResult` instead of
 * throwing when the ownership split does not total 10 000 bps.
 */
export function createLiabilitySafe(
  workspace: Workspace,
  input: CreateLiabilityInput,
  options: { allowKnownPartial?: boolean } = {},
): DomainResult<Liability> {
  assertCurrency(input.currency);
  assertMinorInteger(input.balanceMinor);

  const splitViolation = checkOwnershipSplit(workspace, input.ownership, options);

  if (splitViolation) {
    return { ok: false, violations: [splitViolation] };
  }

  return { ok: true, value: createLiability(workspace, input, options) };
}

function assertCurrency(currency: CurrencyCode): void {
  if (!currency.trim()) {
    throw new Error("Currency is required.");
  }
}

/**
 * Checks the ownership split for the "totals 10 000 bps" rule.
 * Returns a `DomainViolation` when the split is invalid, `null` when valid.
 * Programmer errors (unknown member, non-integer bps) still throw.
 */
export function checkOwnershipSplit(
  workspace: Workspace,
  ownership: OwnershipShare[],
  options: { allowKnownPartial?: boolean } = {},
): Extract<DomainViolation, { code: "ownership_split_invalid" }> | null {
  const knownMemberIds = new Set(workspace.members.map((member) => member.id));
  const totalBps = ownership.reduce((sum, share) => {
    if (!knownMemberIds.has(share.memberId)) {
      throw new Error(`Ownership references unknown member ${share.memberId}.`);
    }

    if (!Number.isInteger(share.shareBps) || share.shareBps <= 0) {
      throw new Error("Ownership share must be a positive integer bps value.");
    }

    return sum + share.shareBps;
  }, 0);

  const isValid = options.allowKnownPartial
    ? totalBps > 0 && totalBps <= 10_000
    : totalBps === 10_000;

  if (!isValid) {
    return { code: "ownership_split_invalid", totalBps };
  }

  return null;
}

function assertOwnership(
  workspace: Workspace,
  ownership: OwnershipShare[],
  options: { allowKnownPartial?: boolean } = {},
): void {
  const violation = checkOwnershipSplit(workspace, ownership, options);

  if (violation) {
    throw new Error("Ownership shares must add up to 10000 bps.");
  }
}

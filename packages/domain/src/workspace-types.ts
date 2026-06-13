import type { CurrencyCode, MoneyMinor } from "./money";
import { assertMinorInteger } from "./money";
import type { LiquidityTier } from "./liquidity-tier";
import type { DomainResult, DomainViolation } from "./domain-result";

export type WorkspaceMode = "individual" | "household";

export interface Member {
  id: string;
  name: string;
  disabledAt?: string;
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
}

export type LiabilityType = "mortgage" | "debt";

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
    isPrimaryResidence: input.isPrimaryResidence ?? false,
    liquidityTier: input.liquidityTier,
    name: input.name,
    ownership: input.ownership,
    type: input.type,
  };
}

export function createLiability(
  workspace: Workspace,
  input: CreateLiabilityInput,
): Liability {
  assertCurrency(input.currency);
  assertMinorInteger(input.balanceMinor);
  assertOwnership(workspace, input.ownership);

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
): DomainResult<Liability> {
  assertCurrency(input.currency);
  assertMinorInteger(input.balanceMinor);

  const splitViolation = checkOwnershipSplit(workspace, input.ownership);

  if (splitViolation) {
    return { ok: false, violations: [splitViolation] };
  }

  return { ok: true, value: createLiability(workspace, input) };
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

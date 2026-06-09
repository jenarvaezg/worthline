import type { DecimalString } from "@worthline/domain";
import type { CreateInvestmentAssetInput } from "@worthline/db";
import type {
  CreateInvestmentOperationInput,
  CreateLiabilityInput,
  CreateManualAssetInput,
  FireScopeConfig,
  Member,
  NetWorthFraming,
  OperationKind,
  OwnershipShare,
} from "@worthline/domain";
import {
  parseDecimal,
  parseDecimalToMinor,
  parseDecimalToMinorStrict,
} from "@worthline/domain";

/**
 * The web intake seam: turns raw HTML form input into validated domain command
 * objects and parses request params. Pure and framework-agnostic (no Next.js),
 * so it can be unit-tested without the runtime and reused by other clients.
 * Domain invariants stay in the domain constructors — intake only shapes input.
 */

export interface WorkspaceInitCommand {
  mode: "individual" | "household";
  members: Member[];
}

export interface SnapshotFormInput {
  scopeId: string;
  isMonthlyClose: boolean;
  replace: boolean;
}

export function parseScopeParam(value: string | string[] | undefined): string {
  return normalizeParam(value) ?? "household";
}

export function parseViewParam(
  value: string | string[] | undefined,
): NetWorthFraming {
  return normalizeParam(value) === "liquid" ? "liquid" : "total";
}

export function parseWorkspaceInit(formData: FormData): WorkspaceInitCommand {
  const mode = formData.get("mode") === "household" ? "household" : "individual";
  const names = parseNames(formData.get("memberNames"));
  const selectedNames = mode === "individual" ? [names[0] ?? "Yo"] : names;

  return {
    members: selectedNames.map((name, index) => ({
      id: createStableId("member", name, index),
      name,
    })),
    mode,
  };
}

export function parseNewMember(formData: FormData, seed: number): Member | null {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return null;
  }

  return { id: createStableId("member", name, seed), name };
}

export function parseEntityId(formData: FormData, field = "id"): string | null {
  const id = String(formData.get(field) ?? "").trim();

  return id || null;
}

export function parseMoneyMinorField(formData: FormData, field: string): number | null {
  return parseDecimalToMinorStrict(String(formData.get(field) ?? ""));
}

export function parseOwnership(formData: FormData, members: Member[]): OwnershipShare[] {
  const activeMembers = members.filter((member) => !member.disabledAt);
  const ownership = activeMembers
    .map((member) => ({
      memberId: member.id,
      shareBps: Math.round(
        parseDecimal(String(formData.get(`owner_${member.id}`) ?? "")) * 100,
      ),
    }))
    .filter((share) => share.shareBps > 0);

  return ownership.length > 0
    ? ownership
    : [{ memberId: activeMembers[0]?.id ?? "", shareBps: 10_000 }];
}

/**
 * Gate ownership shares before they reach the domain. The domain requires shares
 * to total 10000 bps and throws on violation; this surfaces that rule as a
 * user-facing message so the web layer can reject the submission gracefully
 * instead of letting the constructor throw. Returns null when the shares are valid.
 */
export function validateOwnershipShares(shares: OwnershipShare[]): string | null {
  const totalBps = shares.reduce((sum, share) => sum + share.shareBps, 0);

  if (totalBps !== 10_000) {
    return "Los porcentajes de propiedad deben sumar 100%.";
  }

  return null;
}

export function parseAssetCommand(
  formData: FormData,
  members: Member[],
  seed: number,
): CreateManualAssetInput {
  const name = String(formData.get("name") ?? "").trim() || "Activo";

  return {
    currency: "EUR",
    currentValueMinor: parseMoneyMinorField(formData, "currentValue") ?? 0,
    id: createStableId("asset", name, seed),
    isPrimaryResidence: formData.get("isPrimaryResidence") === "on",
    liquidityTier: parseLiquidityTier(formData.get("liquidityTier")),
    name,
    ownership: parseOwnership(formData, members),
    type: parseAssetType(formData.get("type")),
  };
}

export function parseLiabilityCommand(
  formData: FormData,
  members: Member[],
  seed: number,
): CreateLiabilityInput {
  const name = String(formData.get("name") ?? "").trim() || "Deuda";
  const associatedAssetId = String(formData.get("associatedAssetId") ?? "");

  return {
    balanceMinor: parseMoneyMinorField(formData, "balance") ?? 0,
    currency: "EUR",
    id: createStableId("debt", name, seed),
    name,
    ownership: parseOwnership(formData, members),
    type: formData.get("type") === "debt" ? "debt" : "mortgage",
    ...(associatedAssetId ? { associatedAssetId } : {}),
  };
}

export function parseInvestmentAssetCommand(
  formData: FormData,
  members: Member[],
  seed: number,
): CreateInvestmentAssetInput {
  const name = String(formData.get("name") ?? "").trim() || "Inversión";
  const manualPrice = parseDecimalStringInput(
    String(formData.get("manualPricePerUnit") ?? ""),
  );
  const unitSymbol = String(formData.get("unitSymbol") ?? "").trim();
  const isin = String(formData.get("isin") ?? "").trim();

  return {
    currency: "EUR",
    id: createStableId("asset", name, seed),
    liquidityTier: "market",
    name,
    ownership: parseOwnership(formData, members),
    ...(manualPrice !== "0" ? { manualPricePerUnit: manualPrice } : {}),
    ...(unitSymbol ? { unitSymbol } : {}),
    ...(isin ? { isin } : {}),
  };
}

export function parseOperationCommand(
  formData: FormData,
  seed: number,
  today: string,
): CreateInvestmentOperationInput {
  const assetId = String(formData.get("assetId") ?? "");
  const kind: OperationKind = formData.get("kind") === "sell" ? "sell" : "buy";
  const executedAt = String(formData.get("executedAt") ?? "").trim() || today;

  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: parseMoneyMinorField(formData, "fees") ?? 0,
    id: createStableId("op", `${assetId}_${kind}`, seed),
    kind,
    pricePerUnit: parseDecimalStringInput(String(formData.get("pricePerUnit") ?? "")),
    units: parseDecimalStringInput(String(formData.get("units") ?? "")),
  };
}

/**
 * Normalize a raw decimal field (units or price) to a canonical DecimalString
 * without going through a float — preserving precision for high-dp values like
 * crypto units. Accepts es-ES ("1.234,56") and plain ("1234.56") input; anything
 * unparseable becomes "0", which the domain then rejects.
 */
function parseDecimalStringInput(raw: string): DecimalString {
  const trimmed = raw.trim();

  if (!trimmed) {
    return "0";
  }

  const normalized = trimmed.includes(",")
    ? trimmed.replace(/\./g, "").replace(",", ".")
    : trimmed;

  return /^-?\d+(\.\d+)?$/.test(normalized) ? normalized : "0";
}

export function parseFireConfigForm(formData: FormData): FireScopeConfig {
  const monthlySpendingMinor = parseDecimalToMinor(
    (formData.get("monthlySpending") as string) ?? "0",
  );
  const safeWithdrawalRate =
    parseDecimal((formData.get("safeWithdrawalRate") as string) ?? "4") / 100;
  const expectedRealReturn =
    parseDecimal((formData.get("expectedRealReturn") as string) ?? "7") / 100;

  const currentAgeRaw = (formData.get("currentAge") as string | null) ?? "";
  const currentAgeParsed = parseInt(currentAgeRaw, 10);
  const currentAge =
    currentAgeRaw && !Number.isNaN(currentAgeParsed) ? currentAgeParsed : undefined;

  const targetRetirementAgeRaw =
    (formData.get("targetRetirementAge") as string | null) ?? "";
  const targetRetirementAgeParsed = parseInt(targetRetirementAgeRaw, 10);
  const targetRetirementAge = !Number.isNaN(targetRetirementAgeParsed)
    ? targetRetirementAgeParsed
    : 65;

  return {
    excludedAssetIds: [],
    expectedRealReturn,
    monthlySpendingMinor,
    safeWithdrawalRate,
    targetRetirementAge,
    ...(currentAge !== undefined ? { currentAge } : {}),
  };
}

export function parseSnapshotForm(formData: FormData): SnapshotFormInput {
  return {
    isMonthlyClose: formData.get("isMonthlyClose") === "on",
    replace: formData.get("replace") === "on",
    scopeId: String(formData.get("scopeId") ?? "household"),
  };
}

export function buildSnapshotId(
  scopeId: string,
  capturedAt: string,
  seed: number,
): string {
  return createStableId("snapshot", `${scopeId}_${capturedAt.slice(0, 10)}`, seed);
}

function parseNames(value: FormDataEntryValue | null): string[] {
  const names = String(value ?? "")
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter(Boolean);

  return names.length > 0 ? names : ["Yo"];
}

function parseAssetType(
  value: FormDataEntryValue | null,
): CreateManualAssetInput["type"] {
  if (value === "real_estate") {
    return "real_estate";
  }

  if (value === "manual") {
    return "manual";
  }

  return "cash";
}

function parseLiquidityTier(
  value: FormDataEntryValue | null,
): CreateManualAssetInput["liquidityTier"] {
  if (
    value === "market" ||
    value === "retirement" ||
    value === "illiquid" ||
    value === "housing"
  ) {
    return value;
  }

  return "cash";
}

function createStableId(prefix: string, name: string, seed: number): string {
  const slug =
    name
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || prefix;

  return `${prefix}_${slug}_${seed}`;
}

function normalizeParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

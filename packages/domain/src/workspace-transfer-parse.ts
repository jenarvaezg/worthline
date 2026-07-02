/**
 * Validation of an untrusted workspace export document (ADR 0010).
 *
 * `parseWorkspaceExport` is the single gate between a user-supplied JSON file
 * and `importWorkspace`: it checks the version stamp, the structure (via zod),
 * and the domain invariants (ownership splits, ADR 0006 investment valuation,
 * ADR 0008 snapshot reconciliation, referential integrity, id uniqueness) and
 * normalizes absent sections to empty so callers always receive a COMPLETE
 * `WorkspaceExport`. Error messages are Spanish — they surface in the UI.
 */

import { z } from "zod";

import { compareUnits } from "./decimal";
import { createExposureProfile } from "./exposure-lookthrough";
import type { OwnershipShare, Workspace } from "./workspace-types";
import { checkOwnershipSplit } from "./workspace-types";
import { assertSnapshotHoldingsReconcile } from "./snapshot-holdings";
import type {
  ExportedAsset,
  ExportedLiability,
  ExportedPublicIdEntityType,
  WorkspaceExport,
} from "./workspace-transfer";
import { EXPORT_VERSION } from "./workspace-transfer";

export type ParseWorkspaceExportResult =
  | { ok: true; value: WorkspaceExport }
  | { ok: false; errors: [string, ...string[]] };

// ── Structure schema (mirrors the workspace-transfer contract) ──────────────

const nonEmptyString = z.string().min(1);

const moneyMinorSchema = z.object({
  // Integer minor units — the assertMinorInteger invariant at the file boundary.
  amountMinor: z.number().int(),
  currency: nonEmptyString,
});

const ownershipShareSchema = z.object({
  memberId: nonEmptyString,
  shareBps: z.number().int().positive(),
});

const memberSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  disabledAt: nonEmptyString.optional(),
  // Member profile (PRD #421, #423) — optional so pre-profile exports still parse.
  birthYear: z.number().int().optional(),
  fiscalCountry: nonEmptyString.optional(),
  riskTolerance: z.enum(["conservative", "moderate", "aggressive"]).optional(),
});

const groupSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  memberIds: z.array(nonEmptyString),
});

const liquidityTierSchema = z.enum(["cash", "market", "term-locked", "illiquid"]);

const instrumentSchema = z.enum([
  "current_account",
  "term_deposit",
  "fund",
  "etf",
  "stock",
  "index",
  "pension_plan",
  "crypto",
  "precious_metal",
  "vehicle",
  "property",
  "mortgage",
  "loan",
  "credit_card",
  "coin_collection",
  "other",
]);

const investmentMetaSchema = z.object({
  unitSymbol: nonEmptyString.optional(),
  isin: nonEmptyString.optional(),
  priceProvider: z.enum(["yahoo", "stooq", "finect"]).optional(),
  providerSymbol: nonEmptyString.optional(),
  manualPricePerUnit: nonEmptyString.optional(),
  manualPricedAt: nonEmptyString.optional(),
});

const valuationMethodSchema = z.enum([
  "stored",
  "derived",
  "appreciating",
  "amortized",
  "anchored",
]);

const debtModelSchema = z.enum(["amortizable", "revolving", "informal"]);

const valuationCadenceSchema = z.enum(["step", "interpolated"]);

// ── Structural facts (ADR 0015, #155): the full holding model ───────────────

const valuationAnchorSchema = z.object({
  id: nonEmptyString,
  valueMinor: z.number().int(),
  valuationDate: nonEmptyString,
  adjustsPriorCurve: z.boolean(),
});

const interestRateRevisionSchema = z.object({
  id: nonEmptyString,
  revisionDate: nonEmptyString,
  newAnnualInterestRate: nonEmptyString,
});

const earlyRepaymentSchema = z.object({
  id: nonEmptyString,
  repaymentDate: nonEmptyString,
  amountMinor: z.number().int(),
  mode: z.enum(["reduce-payment", "reduce-term"]),
});

const balanceRebaselineSchema = z.object({
  id: nonEmptyString,
  baselineDate: nonEmptyString,
  outstandingBalanceMinor: z.number().int(),
  endDate: nonEmptyString,
  nextPaymentDate: nonEmptyString,
  annualInterestRate: nonEmptyString,
  monthlyPaymentMinor: z.number().int(),
  inputMode: z.enum(["annual-rate", "monthly-payment"]),
  startsAtBaseline: z.boolean(),
});

const amortizationPlanSchema = z.object({
  id: nonEmptyString,
  initialCapitalMinor: z.number().int(),
  annualInterestRate: nonEmptyString,
  termMonths: z.number().int().positive(),
  disbursementDate: nonEmptyString,
  firstPaymentDate: nonEmptyString,
  originalSigningDate: nonEmptyString.optional(),
  interestRateRevisions: z.array(interestRateRevisionSchema).default([]),
  earlyRepayments: z.array(earlyRepaymentSchema).default([]),
});

const balanceAnchorSchema = z.object({
  id: nonEmptyString,
  balanceMinor: z.number().int(),
  anchorDate: nonEmptyString,
});

const assetSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  type: z.enum(["cash", "manual", "real_estate", "investment"]),
  currency: nonEmptyString,
  currentValue: moneyMinorSchema.optional(),
  liquidityTier: liquidityTierSchema,
  isPrimaryResidence: z.boolean().optional(),
  instrument: instrumentSchema.optional(),
  valuationMethod: valuationMethodSchema.optional(),
  valuationCadence: valuationCadenceSchema.optional(),
  annualAppreciationRate: nonEmptyString.optional(),
  valuationAnchors: z.array(valuationAnchorSchema).optional(),
  connectedSourceId: nonEmptyString.optional(),
  ownership: z.array(ownershipShareSchema),
  investment: investmentMetaSchema.optional(),
  deletedAt: nonEmptyString.optional(),
});

const liabilitySchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  type: z.enum(["mortgage", "debt"]),
  currency: nonEmptyString,
  currentBalance: moneyMinorSchema,
  instrument: instrumentSchema.optional(),
  valuationMethod: valuationMethodSchema.optional(),
  valuationCadence: valuationCadenceSchema.optional(),
  debtModel: debtModelSchema.optional(),
  amortizationPlan: amortizationPlanSchema.optional(),
  balanceRebaselines: z.array(balanceRebaselineSchema).optional(),
  balanceAnchors: z.array(balanceAnchorSchema).optional(),
  ownership: z.array(ownershipShareSchema),
  associatedAssetId: nonEmptyString.optional(),
  deletedAt: nonEmptyString.optional(),
});

const operationSchema = z.object({
  id: nonEmptyString,
  assetId: nonEmptyString,
  kind: z.enum(["buy", "sell"]),
  executedAt: nonEmptyString,
  units: nonEmptyString,
  pricePerUnit: nonEmptyString,
  currency: nonEmptyString,
  feesMinor: z.number().int(),
});

const warningOverrideSchema = z.object({
  code: nonEmptyString,
  entityId: nonEmptyString,
});

const fireScopeConfigSchema = z.object({
  monthlySpendingMinor: z.number().int(),
  safeWithdrawalRate: z.number(),
  expectedRealReturn: z.number().optional(),
  currentAge: z.number().optional(),
  targetRetirementAge: z.number().optional(),
  excludedAssetIds: z.array(nonEmptyString).optional(),
  monthlySavingsCapacityMinor: z.number().int().optional(),
  leanMultiplier: z.number().optional(),
  fatMultiplier: z.number().optional(),
  baristaMonthlyIncomeMinor: z.number().int().optional(),
  tierRealReturns: z.record(z.string(), z.number()).optional(),
});

const domainWarningSchema = z.object({
  code: nonEmptyString,
  severity: z.enum(["blocking", "overrideable"]),
  entityType: z.enum(["asset", "liability"]),
  entityId: nonEmptyString,
  message: z.string(),
});

// One frozen per-position child row beneath a connected-source holding (ADR
// 0035, PRD #459 S3): values + labels only, never secrets. A coin's metal and a
// position's thumbnail are nullable; a token freezes both null.
const snapshotPositionSchema = z.object({
  positionKey: nonEmptyString,
  label: nonEmptyString,
  valueMinor: z.number().int(),
  metal: nonEmptyString.nullable(),
  imageUrl: nonEmptyString.nullable(),
});

const snapshotHoldingSchema = z.object({
  // Frozen housing-membership signal for ASSET rows (#181). Defaults false for
  // exports written before the field existed — the same additive basis the v17
  // migration backfill uses, so an old export never claims an asset was a housing
  // asset it cannot prove. Always false for liability rows.
  countsAsHousing: z.boolean().default(false),
  holdingId: nonEmptyString,
  kind: z.enum(["asset", "liability"]),
  label: nonEmptyString,
  liquidityTier: liquidityTierSchema.nullable(),
  // Frozen housing-securing signal (#180). Defaults false for exports written
  // before the field existed — the same additive basis the migration backfill
  // uses, so an old export never claims a debt secures housing it cannot prove.
  securesHousing: z.boolean().default(false),
  valueMinor: z.number().int(),
  units: nonEmptyString.optional(),
  unitPrice: nonEmptyString.optional(),
  // Per-position breakdown of a connected-source holding (ADR 0035, PRD #459 S3).
  // OPTIONAL with NO default: absent must stay `undefined`, never `[]` — the
  // reconciliation skips a holding with no positions, but an empty array would
  // fail the sub-sum (Σ == holding) against the holding's nonzero value. A legacy
  // export omits it entirely and imports unchanged.
  positions: z.array(snapshotPositionSchema).optional(),
});

const snapshotSchema = z.object({
  id: nonEmptyString,
  scopeId: nonEmptyString,
  scopeLabel: nonEmptyString,
  capturedAt: nonEmptyString,
  dateKey: nonEmptyString,
  monthKey: nonEmptyString,
  isMonthlyClose: z.boolean(),
  totalNetWorth: moneyMinorSchema,
  liquidNetWorth: moneyMinorSchema,
  housingEquity: moneyMinorSchema,
  grossAssets: moneyMinorSchema,
  debts: moneyMinorSchema,
  warnings: z.array(domainWarningSchema).default([]),
  holdings: z.array(snapshotHoldingSchema).default([]),
});

const priceSchema = z.object({
  assetId: nonEmptyString,
  currency: nonEmptyString,
  price: nonEmptyString,
  source: z.enum(["manual", "ecb", "coingecko", "stooq", "yahoo", "finect", "numista"]),
  priceDate: nonEmptyString.optional(),
  fetchedAt: nonEmptyString,
  freshnessState: z.enum(["fresh", "stale", "failed", "manual"]),
  staleReason: nonEmptyString.optional(),
});

// ── Connected sources (ADR 0016): the source + its positions, never secrets ──

// A coin position (Numista). `kind` defaults to "coin" so a file written before
// the polymorphism existed (ADR 0021) — which has no `kind` — still imports.
const coinPositionSchema = z.object({
  kind: z.literal("coin").default("coin"),
  id: nonEmptyString,
  externalId: nonEmptyString,
  catalogueId: nonEmptyString,
  issueId: z.number().int().nullable(),
  name: nonEmptyString,
  grade: z.string(),
  quantity: z.number().int(),
  year: z.number().int().nullable(),
  liquidityTier: liquidityTierSchema,
  metal: nonEmptyString.nullable(),
  finenessMillis: z.number().nullable(),
  weightGrams: z.number().nullable(),
  purchaseDate: nonEmptyString.nullable(),
  metalValueMinor: z.number().int().nullable(),
  numismaticValueMinor: z.number().int().nullable(),
  numismaticFetchedAt: nonEmptyString.nullable(),
  purchasePriceMinor: z.number().int().nullable(),
  // The obverse photo URL (#272). Defaults to null so a file written before the
  // gallery existed still imports; re-fetched on the next sync.
  obverseThumbUrl: nonEmptyString.nullable().default(null),
  currency: nonEmptyString,
});

// A token balance (Binance, ADR 0021): symbol/balance/wallet + the last live
// unit price; carried by export/import like any other position (credentials
// never are — they live on `connected_sources`, not here).
const tokenPositionSchema = z.object({
  kind: z.literal("token"),
  id: nonEmptyString,
  externalId: nonEmptyString,
  name: nonEmptyString,
  liquidityTier: liquidityTierSchema,
  currency: nonEmptyString,
  symbol: nonEmptyString,
  balance: nonEmptyString,
  wallet: z.string(),
  unitPrice: nonEmptyString.nullable(),
  // The token's CoinGecko logo URL (#482). Defaults to null so a file written
  // before logos existed still imports; re-fetched on the next sync.
  imageUrl: nonEmptyString.nullable().default(null),
});

// First match wins: a token position fails the coin schema (no catalogue/quantity)
// and parses as a token; a coin position (with or without an explicit `kind`)
// parses as a coin.
const positionSchema = z.union([coinPositionSchema, tokenPositionSchema]);

const connectedSourceSchema = z.object({
  id: nonEmptyString,
  adapter: z.enum(["numista", "binance"]),
  label: nonEmptyString,
  assetId: nonEmptyString,
  lastSyncAt: nonEmptyString.optional(),
  positions: z.array(positionSchema).default([]),
});

const publicIdSchema = z.object({
  entityType: z.enum(["scope", "member", "member_group", "holding"]),
  entityId: nonEmptyString,
  publicId: nonEmptyString,
});

// Exposure profile (PRD #539, ADR 0039): a dimension-agnostic bucket→weight map
// per dimension, plus scalars. Structure only here; the >100% invariant is
// enforced in the domain-error phase via createExposureProfile.
const exposureProfileSchema = z.object({
  key: nonEmptyString,
  trackedIndex: nonEmptyString.nullish(),
  ter: nonEmptyString.nullish(),
  hedged: z.boolean().optional(),
  breakdowns: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});

const documentSchema = z.object({
  version: z.literal(EXPORT_VERSION),
  workspace: z.object({
    mode: z.enum(["individual", "household"]),
    baseCurrency: nonEmptyString,
  }),
  members: z.array(memberSchema).min(1),
  groups: z.array(groupSchema).default([]),
  assets: z.array(assetSchema).default([]),
  liabilities: z.array(liabilitySchema).default([]),
  operations: z.array(operationSchema).default([]),
  warningOverrides: z.array(warningOverrideSchema).default([]),
  fireConfig: z.record(z.string(), fireScopeConfigSchema).default({}),
  snapshots: z.array(snapshotSchema).default([]),
  trash: z
    .object({
      assets: z.array(assetSchema).default([]),
      liabilities: z.array(liabilitySchema).default([]),
    })
    .default({ assets: [], liabilities: [] }),
  priceCache: z.array(priceSchema).default([]),
  connectedSources: z.array(connectedSourceSchema).default([]),
  publicIds: z.array(publicIdSchema).default([]),
  exposureProfiles: z.array(exposureProfileSchema).default([]),
});

// ── Entry point ──────────────────────────────────────────────────────────────

export function parseWorkspaceExport(input: unknown): ParseWorkspaceExportResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail([
      "El archivo no contiene un documento de exportación válido (se esperaba un objeto JSON).",
    ]);
  }

  // Version first, independent of any structural problem: there is
  // intentionally no format-migration ladder (ADR 0010).
  const version = (input as Record<string, unknown>)["version"];

  if (version !== EXPORT_VERSION) {
    return fail([
      version === undefined
        ? `El archivo no indica la versión del formato; esta app solo importa la versión ${EXPORT_VERSION}.`
        : `El archivo usa la versión ${String(version)}; esta app solo importa la versión ${EXPORT_VERSION}.`,
    ]);
  }

  const parsed = documentSchema.safeParse(input);

  if (!parsed.success) {
    return fail(parsed.error.issues.map(describeIssue));
  }

  // zod has stripped unknown keys and filled the section defaults, so at
  // runtime `parsed.data` IS a complete WorkspaceExport. The cast only bridges
  // exactOptionalPropertyTypes (zod types optional fields as `T | undefined`).
  const value = parsed.data as WorkspaceExport;
  const errors = collectDomainErrors(value);

  if (errors.length > 0) {
    return fail(errors);
  }

  return { ok: true, value };
}

function fail(errors: string[]): { ok: false; errors: [string, ...string[]] } {
  const [first, ...rest] = errors;

  return {
    errors: [first ?? "El documento de exportación no es válido.", ...rest],
    ok: false,
  };
}

// ── Zod issues → Spanish messages with their JSON path ──────────────────────

function describePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) {
    return "documento";
  }

  let out = "";

  for (const segment of path) {
    out +=
      typeof segment === "number"
        ? `[${segment}]`
        : out
          ? `.${String(segment)}`
          : String(segment);
  }

  return out;
}

function describeExpectedType(expected: string): string {
  switch (expected) {
    case "int":
      return "un número entero";
    case "number":
      return "un número";
    case "string":
      return "una cadena de texto";
    case "boolean":
      return "un valor booleano";
    case "object":
      return "un objeto";
    case "array":
      return "una lista";
    default:
      return `un valor de tipo ${expected}`;
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const at = describePath(issue.path);

  switch (issue.code) {
    case "invalid_type":
      return `${at}: se esperaba ${describeExpectedType(issue.expected)}.`;
    case "invalid_value":
      return `${at}: valor no admitido; se esperaba uno de ${issue.values
        .map((value) => JSON.stringify(value))
        .join(", ")}.`;
    case "too_small":
      if (issue.origin === "string") {
        return `${at}: no puede estar vacío.`;
      }

      if (issue.origin === "array") {
        return `${at}: debe contener al menos ${String(issue.minimum)} elemento(s).`;
      }

      return `${at}: el valor es demasiado pequeño (mínimo ${String(issue.minimum)}).`;
    default:
      return `${at}: ${issue.message}`;
  }
}

// ── Domain invariants (all errors collected, not just the first) ────────────

function collectDomainErrors(doc: WorkspaceExport): string[] {
  const errors: string[] = [];

  if (doc.workspace.baseCurrency !== "EUR") {
    errors.push(
      `La divisa base del archivo es "${doc.workspace.baseCurrency}"; esta app solo admite EUR.`,
    );
  }

  const allAssets = [...doc.assets, ...doc.trash.assets];
  const allLiabilities = [...doc.liabilities, ...doc.trash.liabilities];

  collectDuplicateIdErrors(
    errors,
    "miembro",
    doc.members.map((member) => member.id),
  );
  collectDuplicateIdErrors(
    errors,
    "grupo",
    doc.groups.map((group) => group.id),
  );
  collectDuplicateIdErrors(
    errors,
    "activo",
    allAssets.map((asset) => asset.id),
  );
  collectDuplicateIdErrors(
    errors,
    "pasivo",
    allLiabilities.map((liability) => liability.id),
  );
  collectDuplicateIdErrors(
    errors,
    "operación",
    doc.operations.map((operation) => operation.id),
  );
  collectDuplicateIdErrors(
    errors,
    "instantánea",
    doc.snapshots.map((snapshot) => snapshot.id),
  );

  collectGroupErrors(errors, doc);
  collectOwnershipErrors(errors, doc, allAssets, allLiabilities);
  collectInvestmentValuationErrors(errors, allAssets);
  collectOperationErrors(errors, doc);
  collectDecimalStringErrors(errors, doc, allAssets, allLiabilities);
  collectStructuralIdErrors(errors, allAssets, allLiabilities);
  collectStructuralKeyErrors(errors, allAssets, allLiabilities);
  collectReferentialIntegrityErrors(errors, doc, allAssets, allLiabilities);
  collectConnectedSourceErrors(errors, doc, allAssets);
  collectDatabaseKeyErrors(errors, doc);
  collectPublicIdErrors(errors, doc);
  collectSnapshotReconciliationErrors(errors, doc);
  collectExposureProfileErrors(errors, doc);

  return errors;
}

const publicIdPrefixByEntityType: Record<ExportedPublicIdEntityType, string> = {
  holding: "wl_hld_",
  member: "wl_mbr_",
  member_group: "wl_grp_",
  scope: "wl_scp_",
};

function collectPublicIdErrors(errors: string[], doc: WorkspaceExport): void {
  if (doc.publicIds.length === 0) {
    return;
  }

  const validTargets = new Set(publicIdTargetsForWorkspaceExport(doc));
  const seenTargets = new Set<string>();
  const seenPublicIds = new Set<string>();

  for (const row of doc.publicIds) {
    const target = `${row.entityType}\0${row.entityId}`;
    const expectedPrefix = publicIdPrefixByEntityType[row.entityType];
    const expectedShape = new RegExp(`^${expectedPrefix}[a-f0-9]{32}$`);

    if (!expectedShape.test(row.publicId)) {
      errors.push(
        `El publicId "${row.publicId}" de publicIds no respeta el prefijo/formato de ${row.entityType}.`,
      );
    }

    if (!validTargets.has(target)) {
      errors.push(
        `El registro publicIds ${row.entityType}/${row.entityId} no apunta a una entidad exportada.`,
      );
    }

    if (seenTargets.has(target)) {
      errors.push(
        `El registro publicIds ${row.entityType}/${row.entityId} está duplicado.`,
      );
    }
    seenTargets.add(target);

    if (seenPublicIds.has(row.publicId)) {
      errors.push(`El publicId "${row.publicId}" está duplicado.`);
    }
    seenPublicIds.add(row.publicId);
  }

  for (const target of validTargets) {
    if (!seenTargets.has(target)) {
      const [entityType, entityId] = target.split("\0");
      errors.push(`Falta el registro publicIds ${entityType}/${entityId}.`);
    }
  }
}

function publicIdTargetsForWorkspaceExport(doc: WorkspaceExport): string[] {
  return [
    publicIdTarget("scope", "household"),
    ...doc.members.flatMap((member) => [
      publicIdTarget("member", member.id),
      publicIdTarget("scope", member.id),
    ]),
    ...doc.groups.flatMap((group) => [
      publicIdTarget("member_group", group.id),
      publicIdTarget("scope", group.id),
    ]),
    // Every holding — asset or liability, live AND trashed — carries a holding
    // public id; trashed holdings keep theirs so a restore stays stable (#335).
    ...[...doc.assets, ...doc.trash.assets].map((asset) =>
      publicIdTarget("holding", asset.id),
    ),
    ...[...doc.liabilities, ...doc.trash.liabilities].map((liability) =>
      publicIdTarget("holding", liability.id),
    ),
  ];
}

function publicIdTarget(
  entityType: ExportedPublicIdEntityType,
  entityId: string,
): string {
  return `${entityType}\0${entityId}`;
}

/**
 * Structural ids must be globally unique within the file (ADR 0015, #155) — they
 * become primary keys on restore (valuation anchors, amortization plans, rate
 * revisions, early repayments, balance anchors), so a collision would otherwise
 * surface as an opaque mid-import constraint violation rather than a clear error.
 */
function collectStructuralIdErrors(
  errors: string[],
  allAssets: ExportedAsset[],
  allLiabilities: ExportedLiability[],
): void {
  collectDuplicateIdErrors(
    errors,
    "anclaje de valoración",
    allAssets.flatMap((asset) => (asset.valuationAnchors ?? []).map((a) => a.id)),
  );
  collectDuplicateIdErrors(
    errors,
    "plan de amortización",
    allLiabilities.flatMap((liability) =>
      liability.amortizationPlan ? [liability.amortizationPlan.id] : [],
    ),
  );
  collectDuplicateIdErrors(
    errors,
    "revisión de tipo",
    allLiabilities.flatMap((liability) =>
      (liability.amortizationPlan?.interestRateRevisions ?? []).map((r) => r.id),
    ),
  );
  collectDuplicateIdErrors(
    errors,
    "amortización anticipada",
    allLiabilities.flatMap((liability) =>
      (liability.amortizationPlan?.earlyRepayments ?? []).map((r) => r.id),
    ),
  );
  collectDuplicateIdErrors(
    errors,
    "recalibración de saldo",
    allLiabilities.flatMap((liability) =>
      (liability.balanceRebaselines ?? []).map((r) => r.id),
    ),
  );
  collectDuplicateIdErrors(
    errors,
    "anclaje de saldo",
    allLiabilities.flatMap((liability) =>
      (liability.balanceAnchors ?? []).map((a) => a.id),
    ),
  );
}

/**
 * Composite (entity, date) uniqueness mirrors the DB unique indexes:
 *   asset_valuations_asset_date_unique, interest_rate_revisions_plan_date_unique,
 *   early_repayments_plan_date_unique, liability_balance_anchors_liability_date_unique.
 * A hand-crafted file with two rows on the same entity+date (distinct ids) passes
 * the id-uniqueness check but would otherwise throw an opaque SQLITE_CONSTRAINT
 * mid-import. Catching it here gives a clean Spanish error and preserves ADR 0010
 * all-or-nothing semantics.
 */
function collectStructuralKeyErrors(
  errors: string[],
  allAssets: ExportedAsset[],
  allLiabilities: ExportedLiability[],
): void {
  // Valuation anchors: unique per (assetId, valuationDate).
  for (const asset of allAssets) {
    collectDuplicateKeyErrors(
      errors,
      `anclaje de valoración por fecha del activo ${asset.id}`,
      asset.valuationAnchors ?? [],
      (a) => a.valuationDate,
      (a) => `${asset.id}/${a.valuationDate}`,
    );
  }

  for (const liability of allLiabilities) {
    const plan = liability.amortizationPlan;
    if (plan) {
      // Interest-rate revisions: unique per (planId, revisionDate).
      collectDuplicateKeyErrors(
        errors,
        `revisión de tipo por fecha del plan ${plan.id}`,
        plan.interestRateRevisions,
        (r) => r.revisionDate,
        (r) => `${plan.id}/${r.revisionDate}`,
      );

      // Early repayments: unique per (planId, repaymentDate).
      collectDuplicateKeyErrors(
        errors,
        `amortización anticipada por fecha del plan ${plan.id}`,
        plan.earlyRepayments,
        (r) => r.repaymentDate,
        (r) => `${plan.id}/${r.repaymentDate}`,
      );
    }

    collectDuplicateKeyErrors(
      errors,
      `recalibración de saldo por fecha del pasivo ${liability.id}`,
      liability.balanceRebaselines ?? [],
      (r) => r.baselineDate,
      (r) => `${liability.id}/${r.baselineDate}`,
    );

    // Balance anchors: unique per (liabilityId, anchorDate).
    collectDuplicateKeyErrors(
      errors,
      `anclaje de saldo por fecha del pasivo ${liability.id}`,
      liability.balanceAnchors ?? [],
      (a) => a.anchorDate,
      (a) => `${liability.id}/${a.anchorDate}`,
    );
  }
}

/**
 * Exposure profiles (PRD #539, ADR 0039): reject duplicate keys and any profile
 * whose breakdown exceeds 100% — the same invariant the write path enforces via
 * createExposureProfile, applied here so a hand-edited file cannot smuggle in a
 * profile that would throw at look-through read time.
 */
function collectExposureProfileErrors(errors: string[], doc: WorkspaceExport): void {
  collectDuplicateIdErrors(
    errors,
    "perfil de exposición",
    doc.exposureProfiles.map((profile) => profile.key),
  );

  for (const profile of doc.exposureProfiles) {
    try {
      createExposureProfile(profile);
    } catch (error) {
      errors.push(
        `El perfil de exposición "${profile.key}" no es válido: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function collectDuplicateIdErrors(errors: string[], kind: string, ids: string[]): void {
  const seen = new Set<string>();
  const reported = new Set<string>();

  for (const id of ids) {
    if (seen.has(id) && !reported.has(id)) {
      errors.push(`Id de ${kind} duplicado: ${id}.`);
      reported.add(id);
    }

    seen.add(id);
  }
}

function collectDuplicateKeyErrors<T>(
  errors: string[],
  kind: string,
  items: T[],
  keyOf: (item: T) => string,
  displayOf: (item: T) => string,
): void {
  const seen = new Set<string>();
  const reported = new Set<string>();

  for (const item of items) {
    const key = keyOf(item);

    if (seen.has(key) && !reported.has(key)) {
      errors.push(`${kind} duplicado: ${displayOf(item)}.`);
      reported.add(key);
    }

    seen.add(key);
  }
}

function collectGroupErrors(errors: string[], doc: WorkspaceExport): void {
  const memberIds = new Set(doc.members.map((member) => member.id));
  const activeMemberIds = new Set(
    doc.members.filter((member) => !member.disabledAt).map((member) => member.id),
  );

  for (const group of doc.groups) {
    const seen = new Set<string>();
    const duplicateMembers = new Set<string>();

    for (const memberId of group.memberIds) {
      if (seen.has(memberId) && !duplicateMembers.has(memberId)) {
        errors.push(
          `El grupo "${group.name}" (${group.id}) contiene el miembro ${memberId} duplicado.`,
        );
        duplicateMembers.add(memberId);
      }

      seen.add(memberId);

      if (!memberIds.has(memberId)) {
        errors.push(
          `El grupo "${group.name}" (${group.id}) referencia un miembro inexistente: ${memberId}.`,
        );
      } else if (!activeMemberIds.has(memberId)) {
        errors.push(
          `El grupo "${group.name}" (${group.id}) referencia el miembro ${memberId}, que está inactivo; los grupos solo pueden contener miembros activos.`,
        );
      }
    }
  }
}

function collectOwnershipErrors(
  errors: string[],
  doc: WorkspaceExport,
  allAssets: ExportedAsset[],
  allLiabilities: ExportedLiability[],
): void {
  // checkOwnershipSplit needs a Workspace; build one straight from the file.
  const workspace: Workspace = {
    baseCurrency: doc.workspace.baseCurrency,
    groups: doc.groups,
    members: doc.members,
    mode: doc.workspace.mode,
  };
  const memberIds = new Set(doc.members.map((member) => member.id));

  // A real_estate asset — and a debt secured against one — may carry a known
  // partial split (co-owned with a non-member, #171); every other holding totals
  // 100%. Mirror the creation rule so a valid export round-trips.
  const realEstateAssetIds = new Set(
    allAssets.filter((asset) => asset.type === "real_estate").map((asset) => asset.id),
  );

  const check = (
    kind: string,
    entity: { id: string; name: string; ownership: OwnershipShare[] },
    allowKnownPartial: boolean,
  ): void => {
    const seenShareMembers = new Set<string>();
    const duplicateShareMembers = new Set<string>();

    for (const share of entity.ownership) {
      if (
        seenShareMembers.has(share.memberId) &&
        !duplicateShareMembers.has(share.memberId)
      ) {
        errors.push(
          `La titularidad de "${entity.name}" (${kind} ${entity.id}) contiene el miembro ${share.memberId} duplicado.`,
        );
        duplicateShareMembers.add(share.memberId);
      }

      seenShareMembers.add(share.memberId);
    }

    const dangling = entity.ownership.filter((share) => !memberIds.has(share.memberId));

    if (dangling.length > 0) {
      for (const share of dangling) {
        errors.push(
          `La titularidad de "${entity.name}" (${kind} ${entity.id}) referencia un miembro inexistente: ${share.memberId}.`,
        );
      }

      // checkOwnershipSplit throws on unknown members — already reported above.
      return;
    }

    const violation = checkOwnershipSplit(workspace, entity.ownership, {
      allowKnownPartial,
    });

    if (violation) {
      errors.push(
        `El reparto de titularidad de "${entity.name}" (${kind} ${entity.id}) suma ${violation.totalBps} puntos básicos; debe sumar 10000.`,
      );
    }
  };

  for (const asset of allAssets) {
    check("activo", asset, asset.type === "real_estate");
  }

  for (const liability of allLiabilities) {
    check(
      "pasivo",
      liability,
      liability.associatedAssetId
        ? realEstateAssetIds.has(liability.associatedAssetId)
        : false,
    );
  }
}

function collectInvestmentValuationErrors(
  errors: string[],
  allAssets: ExportedAsset[],
): void {
  for (const asset of allAssets) {
    if (asset.type === "investment") {
      // ADR 0006 at the file boundary (assertNotInvestmentAsset's invariant):
      // an investment's value is always derived from operations and prices,
      // never hand-valued — a stored currentValue would smuggle one in.
      if (asset.currentValue !== undefined) {
        errors.push(
          `El activo de inversión "${asset.name}" (${asset.id}) no puede llevar un valor manual (currentValue): su valor se deriva de operaciones y precios (ADR 0006).`,
        );
      }

      continue;
    }

    if (asset.currentValue === undefined) {
      errors.push(
        `El activo "${asset.name}" (${asset.id}) no es de inversión y debe llevar currentValue.`,
      );
    }

    if (asset.investment !== undefined) {
      errors.push(
        `El activo "${asset.name}" (${asset.id}) lleva metadatos de inversión pero su tipo es "${asset.type}".`,
      );
    }
  }
}

function collectOperationErrors(errors: string[], doc: WorkspaceExport): void {
  for (const operation of doc.operations) {
    collectDecimalBoundError(errors, {
      label: `Las unidades de la operación ${operation.id}`,
      min: "positive",
      value: operation.units,
    });
    collectDecimalBoundError(errors, {
      label: `El precio por unidad de la operación ${operation.id}`,
      min: "nonNegative",
      value: operation.pricePerUnit,
    });

    if (operation.feesMinor < 0) {
      errors.push(
        `Las comisiones de la operación ${operation.id} no pueden ser negativas.`,
      );
    }
  }
}

function collectDecimalStringErrors(
  errors: string[],
  doc: WorkspaceExport,
  allAssets: ExportedAsset[],
  allLiabilities: ExportedLiability[],
): void {
  for (const asset of allAssets) {
    if (asset.investment?.manualPricePerUnit !== undefined) {
      collectDecimalBoundError(errors, {
        label: `El precio manual de la inversión "${asset.name}" (${asset.id})`,
        min: "positive",
        value: asset.investment.manualPricePerUnit,
      });
    }

    // Appreciation rate (ADR 0015, #155): a decimal drift, may be negative.
    if (asset.annualAppreciationRate !== undefined) {
      collectDecimalValidityError(
        errors,
        `La tasa de revalorización de "${asset.name}" (${asset.id})`,
        asset.annualAppreciationRate,
      );
    }
  }

  for (const liability of allLiabilities) {
    const plan = liability.amortizationPlan;
    for (const rebaseline of liability.balanceRebaselines ?? []) {
      collectDecimalValidityError(
        errors,
        `El tipo de la recalibración ${rebaseline.id} de "${liability.name}" (${liability.id})`,
        rebaseline.annualInterestRate,
      );
    }

    if (!plan) continue;

    collectDecimalValidityError(
      errors,
      `El tipo de interés del plan de "${liability.name}" (${liability.id})`,
      plan.annualInterestRate,
    );

    for (const revision of plan.interestRateRevisions) {
      collectDecimalValidityError(
        errors,
        `El tipo de la revisión ${revision.id} del plan de "${liability.name}" (${liability.id})`,
        revision.newAnnualInterestRate,
      );
    }
  }

  for (const price of doc.priceCache) {
    collectDecimalBoundError(errors, {
      label: `El precio de la caché de precios para ${price.assetId}`,
      min: "nonNegative",
      value: price.price,
    });
  }
}

function collectDecimalValidityError(
  errors: string[],
  label: string,
  value: string,
): void {
  try {
    compareUnits(value, "0");
  } catch {
    errors.push(`${label} debe ser un número decimal válido.`);
  }
}

function collectDecimalBoundError(
  errors: string[],
  input: {
    label: string;
    min: "positive" | "nonNegative";
    value: string;
  },
): void {
  let comparison: number;

  try {
    comparison = compareUnits(input.value, "0");
  } catch {
    errors.push(`${input.label} debe ser un número decimal válido.`);
    return;
  }

  if (input.min === "positive" && comparison <= 0) {
    errors.push(`${input.label} debe ser mayor que 0.`);
  }

  if (input.min === "nonNegative" && comparison < 0) {
    errors.push(`${input.label} no puede ser negativo.`);
  }
}

function collectReferentialIntegrityErrors(
  errors: string[],
  doc: WorkspaceExport,
  allAssets: ExportedAsset[],
  allLiabilities: ExportedLiability[],
): void {
  const assetById = new Map(allAssets.map((asset) => [asset.id, asset]));

  for (const liability of allLiabilities) {
    if (
      liability.associatedAssetId !== undefined &&
      !assetById.has(liability.associatedAssetId)
    ) {
      errors.push(
        `El pasivo "${liability.name}" (${liability.id}) referencia un activo inexistente: ${liability.associatedAssetId}.`,
      );
    }
  }

  for (const operation of doc.operations) {
    const target = assetById.get(operation.assetId);

    if (!target) {
      errors.push(
        `La operación ${operation.id} referencia un activo inexistente: ${operation.assetId}.`,
      );
    } else if (target.type !== "investment") {
      errors.push(
        `La operación ${operation.id} referencia el activo "${target.name}" (${target.id}), que no es de inversión.`,
      );
    }
  }

  for (const price of doc.priceCache) {
    if (!assetById.has(price.assetId)) {
      errors.push(
        `La caché de precios referencia un activo inexistente: ${price.assetId}.`,
      );
    }
  }

  // Snapshot holdings' holdingId is deliberately NOT checked: snapshot rows are
  // frozen history with no live foreign key into holdings (ADR 0008).
}

/**
 * Connected sources (ADR 0016): each source must project into an asset present
 * in the file, source ids and the position ids beneath them must be unique, and
 * no source may smuggle credentials/tokens back in via an unknown key (zod has
 * already stripped those, so this only guards the referential + uniqueness
 * invariants the FKs enforce live).
 */
function collectConnectedSourceErrors(
  errors: string[],
  doc: WorkspaceExport,
  allAssets: ExportedAsset[],
): void {
  const assetById = new Map(allAssets.map((asset) => [asset.id, asset]));

  collectDuplicateIdErrors(
    errors,
    "fuente conectada",
    doc.connectedSources.map((source) => source.id),
  );

  for (const source of doc.connectedSources) {
    if (!assetById.has(source.assetId)) {
      errors.push(
        `La fuente conectada "${source.label}" (${source.id}) referencia un activo inexistente: ${source.assetId}.`,
      );
    }

    collectDuplicateIdErrors(
      errors,
      `posición de la fuente ${source.id}`,
      source.positions.map((position) => position.id),
    );
  }
}

function collectDatabaseKeyErrors(errors: string[], doc: WorkspaceExport): void {
  collectDuplicateKeyErrors(
    errors,
    "override de aviso",
    doc.warningOverrides,
    (override) => `${override.code}\0${override.entityId}`,
    (override) => `${override.code}/${override.entityId}`,
  );

  collectDuplicateKeyErrors(
    errors,
    "precio en caché",
    doc.priceCache,
    (price) => price.assetId,
    (price) => price.assetId,
  );

  collectDuplicateKeyErrors(
    errors,
    "scope/date de instantánea",
    doc.snapshots,
    (snapshot) => `${snapshot.scopeId}\0${snapshot.dateKey}`,
    (snapshot) => `${snapshot.scopeId}/${snapshot.dateKey}`,
  );

  for (const snapshot of doc.snapshots) {
    collectDuplicateKeyErrors(
      errors,
      `posición de la instantánea ${snapshot.id}`,
      snapshot.holdings,
      (holding) => `${holding.kind}\0${holding.holdingId}`,
      (holding) => `${holding.kind}/${holding.holdingId}`,
    );
  }
}

function collectSnapshotReconciliationErrors(
  errors: string[],
  doc: WorkspaceExport,
): void {
  for (const snapshot of doc.snapshots) {
    // Empty/absent holdings are legacy pre-ADR-0008 captures — accepted as-is.
    if (snapshot.holdings.length === 0) {
      continue;
    }

    try {
      assertSnapshotHoldingsReconcile(snapshot.holdings, {
        debtsMinor: snapshot.debts.amountMinor,
        grossAssetsMinor: snapshot.grossAssets.amountMinor,
      });
    } catch {
      errors.push(
        `Las posiciones de la instantánea "${snapshot.id}" (${snapshot.dateKey}) no cuadran con sus cifras de cabecera ni con el desglose por posición (ADR 0008/0035).`,
      );
    }
  }
}

import type { DecimalString } from "@worthline/domain";
import type { CreateInvestmentAssetInput } from "@worthline/db";
import type {
  CreateInvestmentOperationInput,
  CreateLiabilityInput,
  CreateManualAssetInput,
  DomainViolation,
  FireScopeConfig,
  Member,
  MoneyMinor,
  NetWorthFraming,
  OperationKind,
  OwnershipShare,
  PriceFreshnessState,
} from "@worthline/domain";
import {
  parseDecimal,
  parseDecimalToMinor,
  parseDecimalToMinorStrict,
} from "@worthline/domain";

// Re-export types needed by #58 inversiones functions
export type { CreateInvestmentAssetInput };

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

export function parseViewParam(value: string | string[] | undefined): NetWorthFraming {
  return normalizeParam(value) === "liquid" ? "liquid" : "total";
}

/** Set or replace a query param on a (possibly relative) URL string. */
export function appendParam(url: string, key: string, value: string): string {
  const [path, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  params.set(key, value);
  const qs = params.toString();

  return qs ? `${path ?? "/"}?${qs}` : (path ?? "/");
}

/** One-shot post-redirect feedback params — never carried forward in currentUrl. */
const ONE_SHOT_PARAMS = new Set(["ok", "error", "form", "updated", "failed", "anchor"]);
const PRESERVED_VALUE_PREFIX = "v_";

/**
 * The canonical "return here" URL for a server action, rebuilt from the page's
 * search params with every one-shot feedback param stripped so banners and
 * preserved form values never persist across later navigation.
 */
export function buildCurrentUrl(
  searchParams?: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams();

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined) continue;
      if (ONE_SHOT_PARAMS.has(key) || key.startsWith(PRESERVED_VALUE_PREFIX)) continue;

      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, item);
        }
      } else {
        params.set(key, value);
      }
    }
  }

  const queryString = params.toString();

  return queryString ? `/?${queryString}` : "/";
}

/** A validation failure tied to the form that produced it, with the typed input. */
export interface FormErrorContext {
  message: string;
  formId: string | null;
  values: Record<string, string>;
}

/**
 * Build an error redirect that remembers which form failed and what was typed,
 * so the page can render the error beside that form and refill its fields.
 * Optional `anchor` appends a fragment (#id) so the browser scrolls to the row.
 */
export function errorRedirectUrl(
  currentUrl: string,
  error: { message: string; formId?: string; values?: Record<string, string>; anchor?: string },
): string {
  let url = appendParam(currentUrl, "error", error.message);

  if (error.formId) {
    url = appendParam(url, "form", error.formId);
  }

  for (const [field, value] of Object.entries(error.values ?? {})) {
    url = appendParam(url, `${PRESERVED_VALUE_PREFIX}${field}`, value);
  }

  if (error.anchor) {
    url = `${url}#${error.anchor}`;
  }

  return url;
}

/**
 * Build a success redirect with a specific ok-key and an optional anchor fragment.
 * Use this instead of appendParam(currentUrl, "ok", key) when the operation
 * affected a specific row and the user should land at that row.
 */
export function successRedirectUrl(currentUrl: string, okKey: string, anchor?: string): string {
  const url = appendParam(currentUrl, "ok", okKey);

  return anchor ? `${url}#${anchor}` : url;
}

/** Parse the error/form/v_* params of an error redirect back into context. */
export function parseFormError(
  searchParams?: Record<string, string | string[] | undefined>,
): FormErrorContext | null {
  const message = normalizeParam(searchParams?.["error"]);

  if (!message) {
    return null;
  }

  const values: Record<string, string> = {};

  for (const [key, raw] of Object.entries(searchParams ?? {})) {
    if (!key.startsWith(PRESERVED_VALUE_PREFIX)) continue;
    const value = normalizeParam(raw);

    if (value !== undefined) {
      values[key.slice(PRESERVED_VALUE_PREFIX.length)] = value;
    }
  }

  return {
    formId: normalizeParam(searchParams?.["form"]) ?? null,
    message,
    values,
  };
}

/** Collect the user-typed fields worth refilling after a validation error. */
export function preserveFields(
  formData: FormData,
  fields: string[],
  prefixes: string[] = [],
): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, raw] of formData.entries()) {
    if (typeof raw !== "string") continue;

    if (fields.includes(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      values[key] = raw;
    }
  }

  return values;
}

/** Encode a price-refresh outcome (count + failing symbols) into the redirect. */
export function pricesRefreshedRedirectUrl(
  currentUrl: string,
  outcome: { updated: number; failedSymbols: string[] },
): string {
  let url = appendParam(currentUrl, "ok", "prices_refreshed");
  url = appendParam(url, "updated", String(outcome.updated));

  if (outcome.failedSymbols.length > 0) {
    url = appendParam(url, "failed", outcome.failedSymbols.join(","));
  }

  return url;
}

/**
 * Resolve the success banner for the current request. Plain keys map through
 * okMessage; a price refresh reports its outcome (how many updated, which failed).
 */
export function resolveOkMessage(
  searchParams?: Record<string, string | string[] | undefined>,
): string | null {
  const key = normalizeParam(searchParams?.["ok"]);

  if (key !== "prices_refreshed") {
    return okMessage(key);
  }

  const updatedRaw = normalizeParam(searchParams?.["updated"]);

  if (updatedRaw === undefined) {
    return okMessage(key);
  }

  const updated = Number.parseInt(updatedRaw, 10) || 0;
  const failedSymbols = (normalizeParam(searchParams?.["failed"]) ?? "")
    .split(",")
    .map((symbol) => symbol.trim())
    .filter(Boolean);

  if (updated === 0 && failedSymbols.length === 0) {
    return "Sin inversiones con símbolo que actualizar.";
  }

  const failedPart =
    failedSymbols.length > 0 ? ` Con error: ${failedSymbols.join(", ")}.` : "";

  return `Precios actualizados: ${updated}.${failedPart}`;
}

/** Map a success-redirect key to a localized confirmation message (null = no banner). */
export function okMessage(key: string | undefined): string | null {
  if (!key) {
    return null;
  }

  const messages: Record<string, string> = {
    asset_added: "Activo añadido.",
    deleted_recoverable: "Eliminado — recuperable en Papelera.",
    fire_saved: "Configuración FIRE guardada.",
    investment_added: "Inversión añadida.",
    liability_added: "Deuda añadida.",
    prices_refreshed: "Precios actualizados.",
    restored: "Restaurado.",
    saved: "Guardado.",
    valores_actualizados: "Valores actualizados.",
    warning_acknowledged: "Aviso marcado como intencional.",
  };

  // === #57 patrimonio ===

  return messages[key] ?? null;
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

export type OwnershipPreset = "scope" | "even" | "custom";

/**
 * Resolve an ownership split that is guaranteed to total 10000 bps, so a create
 * form can never be rejected for ownership. A single active member always owns
 * 100%. Presets: "scope" (100% to the active scope member), "even" (split
 * equally, distributing the remainder deterministically), and "custom" (honor
 * the entered bps, auto-completing any shortfall across the unset members).
 */
export function resolveOwnershipSplit(input: {
  activeMembers: Member[];
  scopeMemberId?: string | undefined;
  preset: OwnershipPreset;
  customBps?: Record<string, number> | undefined;
}): OwnershipShare[] {
  const members = input.activeMembers;

  if (members.length === 0) {
    return [];
  }

  if (members.length === 1) {
    return [{ memberId: members[0]!.id, shareBps: 10_000 }];
  }

  const scopeMember =
    members.find((member) => member.id === input.scopeMemberId) ?? members[0]!;

  if (input.preset === "scope") {
    return [{ memberId: scopeMember.id, shareBps: 10_000 }];
  }

  if (input.preset === "even") {
    return evenSplit(members);
  }

  const customBps = input.customBps ?? {};
  const entries = members.map((member) => ({
    memberId: member.id,
    shareBps: Math.max(0, Math.round(customBps[member.id] ?? 0)),
  }));
  const provided = entries.reduce((sum, entry) => sum + entry.shareBps, 0);

  if (provided === 0) {
    return [{ memberId: scopeMember.id, shareBps: 10_000 }];
  }

  if (provided < 10_000) {
    const unset = entries.filter((entry) => entry.shareBps === 0);

    if (unset.length > 0) {
      distributeRemainder(unset, 10_000 - provided);
    } else {
      entries[0]!.shareBps += 10_000 - provided;
    }
  } else if (provided > 10_000) {
    for (const entry of entries) {
      entry.shareBps = Math.round((entry.shareBps / provided) * 10_000);
    }
    const drift = 10_000 - entries.reduce((sum, entry) => sum + entry.shareBps, 0);

    if (drift !== 0) {
      largestEntry(entries).shareBps += drift;
    }
  }

  return entries.filter((entry) => entry.shareBps > 0);
}

function evenSplit(members: Member[]): OwnershipShare[] {
  const base = Math.floor(10_000 / members.length);
  let remainder = 10_000 - base * members.length;

  return members.map((member) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;

    return { memberId: member.id, shareBps: base + extra };
  });
}

function distributeRemainder(
  entries: Array<{ memberId: string; shareBps: number }>,
  amount: number,
): void {
  const base = Math.floor(amount / entries.length);
  let remainder = amount - base * entries.length;

  for (const entry of entries) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    entry.shareBps = base + extra;
  }
}

function largestEntry<T extends { shareBps: number }>(entries: T[]): T {
  return entries.reduce((largest, entry) =>
    entry.shareBps > largest.shareBps ? entry : largest,
  );
}

export function parseOwnership(formData: FormData, members: Member[]): OwnershipShare[] {
  const activeMembers = members.filter((member) => !member.disabledAt);
  const preset = parseOwnershipPreset(formData.get("ownershipPreset"));
  const scopeMemberId = String(formData.get("scopeMemberId") ?? "") || undefined;
  const customBps = Object.fromEntries(
    activeMembers.map((member) => [
      member.id,
      Math.round(parseDecimal(String(formData.get(`owner_${member.id}`) ?? "")) * 100),
    ]),
  );

  return resolveOwnershipSplit({ activeMembers, scopeMemberId, preset, customBps });
}

function parseOwnershipPreset(value: FormDataEntryValue | null): OwnershipPreset {
  return value === "scope" || value === "even" ? value : "custom";
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

/**
 * Strict ownership validation: returns the actual sum as a percentage in the
 * error message so the user can see exactly how far off they are.
 * «La propiedad suma 110% — debe sumar 100%»
 * Returns null when the shares total exactly 100%.
 */
export function validateOwnershipSharesStrict(shares: OwnershipShare[]): string | null {
  const totalBps = shares.reduce((sum, share) => sum + share.shareBps, 0);

  if (totalBps === 10_000) {
    return null;
  }

  const actualPct = (totalBps / 100).toFixed(totalBps % 100 === 0 ? 0 : 1);

  return `La propiedad suma ${actualPct}% — debe sumar 100%.`;
}

/**
 * Map a single domain violation to a localized Spanish user-facing message.
 * Intake owns the message text; the domain owns the stable code and context.
 */
export function mapDomainViolation(violation: DomainViolation): string {
  switch (violation.code) {
    case "ownership_split_invalid": {
      const actualPct = (violation.totalBps / 100).toFixed(
        violation.totalBps % 100 === 0 ? 0 : 1,
      );
      return `La propiedad suma ${actualPct}% — debe sumar 100%.`;
    }
  }
}

/** Result type for strict parse functions that can fail with a user-facing error. */
export type StrictParseResult<T> =
  | { ok: true; command: T }
  | { ok: false; error: string };

/**
 * Strict asset command parser: rejects blank names instead of coercing them
 * to "Activo". The caller must redirect on error.
 */
export function parseAssetCommandStrict(
  formData: FormData,
  members: Member[],
  seed: number,
): StrictParseResult<CreateManualAssetInput> {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { ok: false, error: "El nombre del activo es obligatorio." };
  }

  return {
    ok: true,
    command: {
      currency: "EUR",
      currentValueMinor: parseMoneyMinorField(formData, "currentValue") ?? 0,
      id: createStableId("asset", name, seed),
      isPrimaryResidence: formData.get("isPrimaryResidence") === "on",
      liquidityTier: parseLiquidityTier(formData.get("liquidityTier")),
      name,
      ownership: parseOwnership(formData, members),
      type: parseAssetType(formData.get("type")),
    },
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

/** One row in a value-update-pass: either a diff to apply or a parse error. */
export type ValueUpdateCommand =
  | { id: string; newValueMinor: number }
  | { id: string; error: string };

/**
 * Value-update-pass parser: reads a prefilled "puesta al día" form where each
 * row is named `val_<id>`, diffs against the current values, and returns batch
 * update commands only for changed rows. Invalid values produce per-row errors.
 * Investment assets (derived values) should not appear in the form.
 */
export function parseValueUpdatePass(
  formData: FormData,
  currentAssets: Array<{ id: string; currentValueMinor: number }>,
): ValueUpdateCommand[] {
  const commands: ValueUpdateCommand[] = [];

  for (const asset of currentAssets) {
    const raw = formData.get(`val_${asset.id}`);

    if (raw === null) {
      continue;
    }

    const newValueMinor = parseDecimalToMinorStrict(String(raw));

    if (newValueMinor === null) {
      commands.push({ id: asset.id, error: `Valor inválido para ${asset.id}.` });
      continue;
    }

    if (newValueMinor !== asset.currentValueMinor) {
      commands.push({ id: asset.id, newValueMinor });
    }
  }

  return commands;
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

/**
 * Strict FIRE config parser: rejects garbage inputs (zero/negative spending,
 * zero rates) instead of silently producing a config that yields "FIRE alcanzado"
 * from invalid data. Returns an error describing the first invalid field.
 */
export function parseFireConfigFormStrict(
  formData: FormData,
): StrictParseResult<FireScopeConfig> {
  const monthlySpendingRaw = (formData.get("monthlySpending") as string) ?? "";
  const monthlySpendingMinor = parseDecimalToMinorStrict(monthlySpendingRaw);

  if (monthlySpendingMinor === null || monthlySpendingMinor <= 0) {
    return {
      ok: false,
      error: "El gasto mensual debe ser un número positivo.",
    };
  }

  const safeWithdrawalRateRaw = (formData.get("safeWithdrawalRate") as string) ?? "";
  const safeWithdrawalRatePct = parseDecimal(safeWithdrawalRateRaw);

  if (!safeWithdrawalRatePct || safeWithdrawalRatePct <= 0) {
    return {
      ok: false,
      error: "La tasa de retirada segura debe ser un número positivo.",
    };
  }

  const expectedRealReturnRaw = (formData.get("expectedRealReturn") as string) ?? "";
  const expectedRealReturnPct = parseDecimal(expectedRealReturnRaw);

  if (!expectedRealReturnPct || expectedRealReturnPct <= 0) {
    return {
      ok: false,
      error: "El retorno real esperado debe ser un número positivo.",
    };
  }

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
    ok: true,
    command: {
      excludedAssetIds: [],
      expectedRealReturn: expectedRealReturnPct / 100,
      monthlySpendingMinor,
      safeWithdrawalRate: safeWithdrawalRatePct / 100,
      targetRetirementAge,
      ...(currentAge !== undefined ? { currentAge } : {}),
    },
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

export function createStableId(prefix: string, name: string, seed: number): string {
  const slug =
    name
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || prefix;

  return `${prefix}_${slug}_${seed}`;
}

/**
 * The name of the HTTP cookie that persists the active scope across pages and
 * sessions. Value is a raw scope ID string (member ID or "household").
 */
export const SCOPE_COOKIE_NAME = "wl_scope";

/**
 * Parse the scope cookie value to a scope ID string.
 * Returns undefined when the cookie is absent or blank so callers can fall
 * back to the household/first-scope default.
 */
export function parseScopeCookie(cookieValue: string | undefined): string | undefined {
  if (!cookieValue) {
    return undefined;
  }

  const trimmed = cookieValue.trim();

  return trimmed || undefined;
}

function normalizeParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

// === #55 empezar ===

/**
 * Parse the «Empezar solo» form (individual path).
 * Expects a single `name` field. Rejects blank names so the error is visible
 * and the typed value can be preserved via the intake v2 redirect pattern.
 */
export function parseEmpezarSolo(formData: FormData): StrictParseResult<WorkspaceInitCommand> {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { ok: false, error: "El nombre es obligatorio." };
  }

  return {
    ok: true,
    command: {
      mode: "individual",
      members: [{ id: createStableId("member", name, 0), name }],
    },
  };
}

/**
 * Parse the «Crear hogar» form (household path).
 * Expects a `memberNames` textarea with one name per line. Blank lines are
 * filtered silently. Rejects if no non-blank names remain.
 */
export function parseEmpezarHogar(formData: FormData): StrictParseResult<WorkspaceInitCommand> {
  const names = String(formData.get("memberNames") ?? "")
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);

  if (names.length === 0) {
    return { ok: false, error: "Añade al menos un nombre." };
  }

  return {
    ok: true,
    command: {
      mode: "household",
      members: names.map((name, index) => ({
        id: createStableId("member", name, index),
        name,
      })),
    },
  };
}

// === #59 historico ===

/**
 * Returns the bar width (0–100, minimum 4 when non-zero) for a signed delta,
 * scaled relative to the maximum absolute delta across the provided set.
 *
 * Used by /historico to render zero-centered green/red bars whose width is
 * proportional to the magnitude of each row's Δ, not to its absolute net worth.
 *
 * @param delta - The delta for this row (undefined → 0).
 * @param allDeltas - All row deltas (including undefined) to derive the max from.
 */
export function scaleSignedBar(
  delta: MoneyMinor | undefined,
  allDeltas: Array<MoneyMinor | undefined>,
): number {
  if (!delta || delta.amountMinor === 0) {
    return 0;
  }

  const max = Math.max(
    0,
    ...allDeltas
      .filter((d): d is MoneyMinor => d !== undefined)
      .map((d) => Math.abs(d.amountMinor)),
  );

  if (max === 0) {
    return 0;
  }

  return Math.max(4, Math.round((Math.abs(delta.amountMinor) / max) * 100));
}

// === #58 inversiones ===

/**
 * buildCurrentUrlFor: like buildCurrentUrl but prepends a fixed basePath so
 * subpages (/inversiones/nueva, /inversiones/[id]/operacion, etc.) get the
 * right return URL without knowing the page URL at parse time.
 */
export function buildCurrentUrlFor(
  basePath: string,
  searchParams?: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams();

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined) continue;
      if (ONE_SHOT_PARAMS.has(key) || key.startsWith(PRESERVED_VALUE_PREFIX)) continue;

      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, item);
        }
      } else {
        params.set(key, value);
      }
    }
  }

  const queryString = params.toString();

  return queryString ? `${basePath}?${queryString}` : basePath;
}

/**
 * Strict investment asset parser for /inversiones/nueva: requires a name,
 * rejects a manual price that cannot be parsed (instead of silently dropping
 * it to 0). Returns an error on first violation.
 */
export function parseInvestmentAssetCommandStrict(
  formData: FormData,
  members: Member[],
  seed: number,
): StrictParseResult<CreateInvestmentAssetInput> {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { ok: false, error: "El nombre de la inversión es obligatorio." };
  }

  const manualPriceRaw = String(formData.get("manualPricePerUnit") ?? "").trim();
  let manualPrice: DecimalString | undefined;

  if (manualPriceRaw) {
    // Normalize es-ES format then validate — must be a positive number.
    const normalized = manualPriceRaw.includes(",")
      ? manualPriceRaw.replace(/\./g, "").replace(",", ".")
      : manualPriceRaw;

    if (!/^\d+(\.\d+)?$/.test(normalized) || parseFloat(normalized) < 0) {
      return {
        ok: false,
        error: "El precio manual no es válido. Introduce un número positivo o déjalo en blanco.",
      };
    }

    if (normalized !== "0") {
      manualPrice = normalized as DecimalString;
    }
  }

  const unitSymbol = String(formData.get("unitSymbol") ?? "").trim();
  const isin = String(formData.get("isin") ?? "").trim();

  return {
    ok: true,
    command: {
      currency: "EUR",
      id: createStableId("asset", name, seed),
      liquidityTier: "market",
      name,
      ownership: parseOwnership(formData, members),
      ...(manualPrice !== undefined ? { manualPricePerUnit: manualPrice } : {}),
      ...(unitSymbol ? { unitSymbol } : {}),
      ...(isin ? { isin } : {}),
    },
  };
}

/**
 * Route-scoped operation parser: the asset id comes from the URL route
 * (not a dropdown), preventing silent no-op on unselected dropdown.
 * Never silently swallows a bad units/price/fees field — returns an error
 * that names the offending field.
 */
export function parseRouteOperationCommand(
  formData: FormData,
  routeAssetId: string,
  seed: number,
  today: string,
): StrictParseResult<CreateInvestmentOperationInput> {
  const unitsRaw = String(formData.get("units") ?? "").trim();
  const priceRaw = String(formData.get("pricePerUnit") ?? "").trim();

  if (!unitsRaw) {
    return { ok: false, error: "Las unidades son obligatorias." };
  }

  if (!priceRaw) {
    return { ok: false, error: "El precio por unidad es obligatorio." };
  }

  const normalizeDecimal = (raw: string): string => {
    const trimmed = raw.trim();
    const normalized = trimmed.includes(",")
      ? trimmed.replace(/\./g, "").replace(",", ".")
      : trimmed;

    return /^-?\d+(\.\d+)?$/.test(normalized) ? normalized : "0";
  };

  const units = normalizeDecimal(unitsRaw) as DecimalString;
  const pricePerUnit = normalizeDecimal(priceRaw) as DecimalString;

  if (units === "0") {
    return { ok: false, error: "Las unidades deben ser un número positivo." };
  }

  if (pricePerUnit === "0" && priceRaw !== "0" && priceRaw !== "0,00") {
    return { ok: false, error: "El precio por unidad no es válido." };
  }

  const feesRaw = String(formData.get("fees") ?? "0");
  const feesMinor = parseDecimalToMinorStrict(feesRaw);

  if (feesMinor === null || feesMinor < 0) {
    return { ok: false, error: "Las comisiones no son válidas." };
  }

  const kind: OperationKind = formData.get("kind") === "sell" ? "sell" : "buy";
  const executedAt = String(formData.get("executedAt") ?? "").trim() || today;

  return {
    ok: true,
    command: {
      assetId: routeAssetId,
      currency: "EUR",
      executedAt,
      feesMinor,
      id: createStableId("op", `${routeAssetId}_${kind}`, seed),
      kind,
      pricePerUnit,
      units,
    },
  };
}

/**
 * Edit investment parser: strict name required, manual price rejected when
 * unparseable (not silently dropped to 0).
 */
export function parseUpdateInvestmentCommand(
  formData: FormData,
  assetId: string,
): StrictParseResult<{ id: string; name: string; unitSymbol?: string; isin?: string; manualPricePerUnit?: DecimalString }> {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { ok: false, error: "El nombre de la inversión es obligatorio." };
  }

  const manualPriceRaw = String(formData.get("manualPricePerUnit") ?? "").trim();
  let manualPrice: DecimalString | undefined;

  if (manualPriceRaw) {
    const normalized = manualPriceRaw.includes(",")
      ? manualPriceRaw.replace(/\./g, "").replace(",", ".")
      : manualPriceRaw;

    if (!/^\d+(\.\d+)?$/.test(normalized) || parseFloat(normalized) < 0) {
      return {
        ok: false,
        error: "El precio manual no es válido. Introduce un número positivo o déjalo en blanco.",
      };
    }

    if (normalized !== "0") {
      manualPrice = normalized as DecimalString;
    }
  }

  const unitSymbol = String(formData.get("unitSymbol") ?? "").trim();
  const isin = String(formData.get("isin") ?? "").trim();

  return {
    ok: true,
    command: {
      id: assetId,
      name,
      ...(manualPrice !== undefined ? { manualPricePerUnit: manualPrice } : {}),
      ...(unitSymbol ? { unitSymbol } : {}),
      ...(isin ? { isin } : {}),
    },
  };
}


/** Map a price freshness state to a localized label (shared by /inversiones pages). */
export function priceFreshnessLabel(freshness: PriceFreshnessState | null): string {
  if (!freshness) return "—";
  const labels: Record<PriceFreshnessState, string> = {
    failed: "Fallido",
    fresh: "Reciente",
    manual: "Manual",
    stale: "Obsoleto",
  };
  return labels[freshness];
}

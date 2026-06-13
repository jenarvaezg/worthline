import type { DecimalString } from "@worthline/domain";
import type {
  AddBalanceAnchorInput,
  AddEarlyRepaymentInput,
  AddInterestRateRevisionInput,
  AddValuationAnchorInput,
  CreateAmortizationPlanInput,
  CreateInvestmentAssetInput,
} from "@worthline/db";
import type {
  CompositionRange,
  CreateInvestmentOperationInput,
  CreateLiabilityInput,
  CreateManualAssetInput,
  DebtModel,
  DomainViolation,
  DrilldownKey,
  FireScopeConfig,
  InvestmentPriceProvider,
  LiquidityTier,
  Member,
  MoneyMinor,
  NetWorthFraming,
  OperationKind,
  OwnershipShare,
  PriceFreshnessState,
} from "@worthline/domain";
import {
  parseDecimal,
  parseDecimalStrict,
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

export function parseScopeParam(
  value: string | string[] | undefined,
): string | undefined {
  const raw = normalizeParam(value);
  const trimmed = raw?.trim();

  return trimmed || undefined;
}

/**
 * Parse the `drill=` query param (#76, #77). Only known drill keys activate a
 * drill view — anything else means no drill. Composable with `view=`.
 */
export function parseDrillParam(
  value: string | string[] | undefined,
): DrilldownKey | null {
  const raw = normalizeParam(value);

  return raw === "liquid" || raw === "rest" || raw === "housing" || raw === "debts"
    ? raw
    : null;
}

/**
 * Parse the `range=` query param (#144): the composition chart's temporal window.
 * Only the bounded ranges activate a window — anything else (including the
 * default) means the full captured history. Composable with `view=` and `drill=`.
 */
export function parseRangeParam(value: string | string[] | undefined): CompositionRange {
  const raw = normalizeParam(value);

  return raw === "1y" || raw === "3y" || raw === "5y" ? raw : "all";
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
const ONE_SHOT_PARAMS = new Set([
  "ok",
  "error",
  "form",
  "updated",
  "failed",
  "anchor",
  // Symbol-search state (#138): the query and the picked candidate's prefill
  // live in the URL only while the user is choosing — never carried into the
  // action return URL.
  "symbolq",
  "pfName",
  "pfSymbol",
  "pfProvider",
]);
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
  error: {
    message: string;
    formId?: string;
    values?: Record<string, string>;
    anchor?: string;
  },
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
export function successRedirectUrl(
  currentUrl: string,
  okKey: string,
  anchor?: string,
): string {
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

/** A failed price refresh paired with the reason it failed (issue #137). */
export interface PriceRefreshFailure {
  symbol: string;
  reason: string;
}

/** Entry separator and symbol/reason separator for the `failed` param. */
const FAILURE_ENTRY_SEP = "|";
const FAILURE_REASON_SEP = ":";

/** Encode a price-refresh outcome (count + failing symbols/reasons) into the redirect. */
export function pricesRefreshedRedirectUrl(
  currentUrl: string,
  outcome: { updated: number; failures: PriceRefreshFailure[] },
): string {
  let url = appendParam(currentUrl, "ok", "prices_refreshed");
  url = appendParam(url, "updated", String(outcome.updated));

  if (outcome.failures.length > 0) {
    const encoded = outcome.failures
      .map((f) => (f.reason ? `${f.symbol}${FAILURE_REASON_SEP}${f.reason}` : f.symbol))
      .join(FAILURE_ENTRY_SEP);
    url = appendParam(url, "failed", encoded);
  }

  return url;
}

/** Decode the `failed` param back into symbol/reason pairs. */
function parseFailures(raw: string | undefined): PriceRefreshFailure[] {
  if (!raw) return [];

  return raw
    .split(FAILURE_ENTRY_SEP)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const sepAt = entry.indexOf(FAILURE_REASON_SEP);

      return sepAt === -1
        ? { symbol: entry, reason: "" }
        : { symbol: entry.slice(0, sepAt), reason: entry.slice(sepAt + 1) };
    });
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
  const failures = parseFailures(normalizeParam(searchParams?.["failed"]));

  if (updated === 0 && failures.length === 0) {
    return "Sin inversiones con símbolo que actualizar.";
  }

  const failedPart =
    failures.length > 0
      ? ` Con error: ${failures
          .map((f) => (f.reason ? `${f.symbol} (${f.reason})` : f.symbol))
          .join(", ")}.`
      : "";

  return `Precios actualizados: ${updated}.${failedPart}`;
}

/** Map a success-redirect key to a localized confirmation message (null = no banner). */
export function okMessage(key: string | undefined): string | null {
  if (!key) {
    return null;
  }

  const messages: Record<string, string> = {
    anchor_added: "Tasación registrada.",
    anchor_deleted: "Tasación eliminada.",
    anchor_saved: "Tasación actualizada.",
    asset_added: "Activo añadido.",
    balance_anchor_added: "Saldo registrado.",
    balance_anchor_deleted: "Saldo eliminado.",
    balance_anchor_saved: "Saldo actualizado.",
    debt_model_saved: "Modelo de deuda guardado.",
    deleted_recoverable: "Eliminado — recuperable en Papelera.",
    fire_saved: "Configuración FIRE guardada.",
    hard_deleted: "Eliminado definitivamente.",
    investment_added: "Inversión añadida.",
    liability_added: "Deuda añadida.",
    member_deleted: "Miembro borrado definitivamente.",
    operation_deleted: "Operación eliminada.",
    plan_deleted: "Plan de amortización eliminado.",
    plan_saved: "Plan de amortización guardado.",
    prices_refreshed: "Precios actualizados.",
    repayment_added: "Amortización anticipada registrada.",
    repayment_deleted: "Amortización anticipada eliminada.",
    repayment_saved: "Amortización anticipada actualizada.",
    rate_saved: "Tasa de revalorización guardada.",
    revision_added: "Revisión de tipo registrada.",
    revision_deleted: "Revisión de tipo eliminada.",
    revision_saved: "Revisión de tipo actualizada.",
    restored: "Restaurado.",
    saved: "Guardado.",
    trash_emptied: "Papelera vaciada.",
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
 * Resolve an ownership split from form input. A single active member always owns
 * 100%. Presets: "scope" (100% to the active scope member), "even" (split
 * equally, distributing the remainder deterministically), and "custom" (honor
 * entered bps, auto-completing shortfalls only across unset members).
 */
export function resolveOwnershipSplit(input: {
  activeMembers: Member[];
  scopeMemberId?: string | undefined;
  preset: OwnershipPreset;
  customBps?: Record<string, number> | undefined;
  completeShortfall?: boolean | undefined;
}): OwnershipShare[] {
  const members = input.activeMembers;

  if (members.length === 0) {
    return [];
  }

  const scopeMember =
    members.find((member) => member.id === input.scopeMemberId) ?? members[0]!;

  if (members.length === 1 && input.preset !== "custom") {
    return [{ memberId: scopeMember.id, shareBps: 10_000 }];
  }

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

  if ((input.completeShortfall ?? true) && provided < 10_000) {
    const unset = entries.filter((entry) => entry.shareBps === 0);

    if (unset.length > 0) {
      distributeRemainder(unset, 10_000 - provided);
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

export function parseOwnership(
  formData: FormData,
  members: Member[],
  options: { completeShortfall?: boolean } = {},
): OwnershipShare[] {
  const activeMembers = members.filter((member) => !member.disabledAt);
  const preset = parseOwnershipPreset(formData.get("ownershipPreset"));
  const scopeMemberId = String(formData.get("scopeMemberId") ?? "") || undefined;
  const customBps = Object.fromEntries(
    activeMembers.map((member) => [
      member.id,
      Math.round(parseDecimal(String(formData.get(`owner_${member.id}`) ?? "")) * 100),
    ]),
  );

  return resolveOwnershipSplit({
    activeMembers,
    completeShortfall: options.completeShortfall,
    customBps,
    preset,
    scopeMemberId,
  });
}

function parseOwnershipPreset(value: FormDataEntryValue | null): OwnershipPreset {
  return value === "scope" || value === "even" ? value : "custom";
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
    case "operation_units_not_positive":
      return "Las unidades deben ser un número positivo.";
    case "operation_price_negative":
      return "El precio por unidad no es válido.";
    case "operation_fees_negative":
      return "Las comisiones no son válidas.";
    case "investment_manual_valuation_rejected":
      return "El valor de una inversión es siempre calculado — registra una operación o actualiza el precio.";
    case "value_update_investment_holding":
      return "Las inversiones no se pueden actualizar en la puesta al día — su valor es siempre calculado.";
  }
}

/** Result type for strict parse functions that can fail with a user-facing error. */
export type StrictParseResult<T> =
  | { ok: true; command: T }
  | { ok: false; error: string };

/**
 * Strict asset command parser: rejects blank names instead of coercing them
 * to "Activo". The caller must redirect on error.
 * For real_estate assets, also parses optional acquisition data (date + value)
 * to create an initial valuation anchor.
 */
export function parseAssetCommandStrict(
  formData: FormData,
  members: Member[],
  seed: number,
): StrictParseResult<CreateManualAssetInput & HousingCreationData> {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { ok: false, error: "El nombre del activo es obligatorio." };
  }

  const type = parseAssetType(formData.get("type"));
  const liquidityTier =
    type === "real_estate"
      ? "illiquid"
      : parseLiquidityTier(formData.get("liquidityTier"));

  const housingData = parseHousingCreationData(formData, type);

  if (!housingData.ok) {
    return { ok: false, error: housingData.error };
  }

  return {
    ok: true,
    command: {
      currency: "EUR",
      currentValueMinor:
        type === "real_estate" && housingData.data.acquisitionValueMinor !== undefined
          ? housingData.data.acquisitionValueMinor
          : (parseMoneyMinorField(formData, "currentValue") ?? 0),
      id: createStableId("asset", name, seed),
      isPrimaryResidence: formData.get("isPrimaryResidence") === "on",
      liquidityTier,
      name,
      ownership: parseOwnership(formData, members, {
        completeShortfall: type !== "real_estate",
      }),
      type,
      ...(housingData.data.acquisitionDate
        ? { acquisitionDate: housingData.data.acquisitionDate }
        : {}),
      ...(housingData.data.acquisitionValueMinor !== undefined
        ? { acquisitionValueMinor: housingData.data.acquisitionValueMinor }
        : {}),
      ...(housingData.data.annualAppreciationRate !== undefined
        ? { annualAppreciationRate: housingData.data.annualAppreciationRate }
        : {}),
      ...(housingData.data.initialValuation
        ? { initialValuation: housingData.data.initialValuation }
        : {}),
    },
  };
}

/** Creation-only housing fields that are persisted after the asset exists. */
export interface HousingCreationData {
  acquisitionDate?: string;
  acquisitionValueMinor?: number;
  annualAppreciationRate?: DecimalString | null;
  initialValuation?: {
    adjustsPriorCurve: boolean;
    valuationDate: string;
    valueMinor: number;
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseHousingCreationData(
  formData: FormData,
  type: CreateManualAssetInput["type"],
): { ok: true; data: HousingCreationData } | { ok: false; error: string } {
  if (type !== "real_estate") {
    return { ok: true, data: {} };
  }

  const date = String(formData.get("acquisitionDate") ?? "").trim();
  const valueRaw = formData.get("acquisitionValue");

  if (!date && !valueRaw) {
    return {
      ok: false,
      error: "La fecha y el precio de adquisición son obligatorios para un inmueble.",
    };
  }

  if (date && !valueRaw) {
    return {
      ok: false,
      error: "Si indicas la fecha de adquisición, también debes indicar el precio.",
    };
  }

  if (!date && valueRaw) {
    return {
      ok: false,
      error: "Si indicas el precio de adquisición, también debes indicar la fecha.",
    };
  }

  if (!ISO_DATE.test(date)) {
    return { ok: false, error: "La fecha de adquisición no es válida." };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (date > today) {
    return { ok: false, error: "La fecha de adquisición no puede ser futura." };
  }

  const valueMinor = parseMoneyMinorField(formData, "acquisitionValue");
  if (valueMinor === null || valueMinor <= 0) {
    return { ok: false, error: "El precio de adquisición debe ser un número positivo." };
  }

  const rate = parseAppreciationRateStrict(formData);

  if (!rate.ok) {
    return { ok: false, error: rate.error };
  }

  const initialValuation = parseInitialValuation(formData, date, today);

  if (!initialValuation.ok) {
    return { ok: false, error: initialValuation.error };
  }

  return {
    ok: true,
    data: {
      acquisitionDate: date,
      acquisitionValueMinor: valueMinor,
      annualAppreciationRate: rate.rate,
      ...(initialValuation.valuation
        ? { initialValuation: initialValuation.valuation }
        : {}),
    },
  };
}

function parseInitialValuation(
  formData: FormData,
  acquisitionDate: string,
  today: string,
):
  | { ok: true; valuation?: HousingCreationData["initialValuation"] }
  | { ok: false; error: string } {
  const valuationDate = String(formData.get("initialValuationDate") ?? "").trim();
  const valueRaw = formData.get("initialValuationValue");

  if (!valuationDate && !valueRaw) {
    return { ok: true };
  }

  if (valuationDate && !valueRaw) {
    return {
      ok: false,
      error:
        "Si indicas la fecha de la tasación inicial, también debes indicar el valor.",
    };
  }

  if (!valuationDate && valueRaw) {
    return {
      ok: false,
      error:
        "Si indicas el valor de la tasación inicial, también debes indicar la fecha.",
    };
  }

  if (!ISO_DATE.test(valuationDate)) {
    return { ok: false, error: "La fecha de la tasación inicial no es válida." };
  }

  if (valuationDate > today) {
    return { ok: false, error: "La fecha de la tasación inicial no puede ser futura." };
  }

  if (valuationDate === acquisitionDate) {
    return {
      ok: false,
      error: "La tasación inicial debe tener una fecha distinta a la adquisición.",
    };
  }

  const valueMinor = parseMoneyMinorField(formData, "initialValuationValue");

  if (valueMinor === null || valueMinor <= 0) {
    return {
      ok: false,
      error: "El valor de la tasación inicial debe ser un número positivo.",
    };
  }

  return {
    ok: true,
    valuation: {
      adjustsPriorCurve: formData.get("initialAdjustsPriorCurve") === "on",
      valuationDate,
      valueMinor,
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

/**
 * Strict housing valuation anchor parser (PRD #108, slice 6). Builds an
 * AddValuationAnchorInput from the «declarar tasación / mejora» form. Validates
 * server-side: the date is present, ISO YYYY-MM-DD, and not in the future
 * (future anchors generate no history, so we reject them outright); the value
 * is a positive amount. The `adjustsPriorCurve` checkbox distinguishes a market
 * appraisal (total truth) from an improvement (increment). The caller redirects
 * on error.
 */
export function parseValuationAnchorStrict(
  formData: FormData,
  assetId: string,
  seed: number,
  today: string,
): StrictParseResult<AddValuationAnchorInput> {
  const valuationDate = String(formData.get("valuationDate") ?? "").trim();

  if (!valuationDate) {
    return { ok: false, error: "La fecha de la tasación es obligatoria." };
  }

  if (!ISO_DATE.test(valuationDate)) {
    return { ok: false, error: "La fecha de la tasación no es válida." };
  }

  if (valuationDate > today) {
    return { ok: false, error: "La fecha no puede ser futura." };
  }

  const valueMinor = parseMoneyMinorField(formData, "anchorValue");

  if (valueMinor === null || valueMinor <= 0) {
    return { ok: false, error: "El valor debe ser un número positivo." };
  }

  return {
    ok: true,
    command: {
      adjustsPriorCurve: formData.get("adjustsPriorCurve") === "on",
      assetId,
      id: createStableId("anchor", assetId, seed),
      valuationDate,
      valueMinor,
    },
  };
}

/** Result of parsing the appreciation-rate form: ok with the decimal rate (or null = clear). */
export type AppreciationRateResult =
  | { ok: true; rate: DecimalString | null }
  | { ok: false; error: string };

/**
 * Strict appreciation-rate parser (PRD #108, slice 6). The user types an annual
 * percentage (e.g. "3" for 3 %, es-ES "2,5" for 2.5 %); we persist it as a
 * decimal string ("0.03", "0.025"). A blank input clears the rate (null). The
 * rate must be non-negative. The caller redirects on error.
 */
export function parseAppreciationRateStrict(formData: FormData): AppreciationRateResult {
  const raw = String(formData.get("rate") ?? "").trim();

  if (!raw) {
    return { ok: true, rate: null };
  }

  const pct = parseDecimalStrict(raw);

  if (pct === null) {
    return { ok: false, error: "La tasa de revalorización no es válida." };
  }

  if (pct < 0) {
    return { ok: false, error: "La tasa de revalorización no puede ser negativa." };
  }

  // Convert percent → decimal, then trim trailing-zero/float noise to a clean
  // decimal string the store accepts (e.g. 2.5 % → "0.025", 3 % → "0.03").
  const decimal = pct / 100;
  const rate = (
    Number.isInteger(decimal) ? String(decimal) : decimal.toString()
  ) as DecimalString;

  return { ok: true, rate };
}

/** Result of parsing the debt-model selector: ok with the model (or null = clear). */
export type DebtModelResult =
  | { ok: true; model: DebtModel | null }
  | { ok: false; error: string };

/**
 * Strict debt-model parser (PRD #109, slice 10). The «modelo de deuda» selector
 * posts one of the three known models, or an empty value to clear it (null = no
 * model). Anything else is rejected. The caller redirects on error.
 */
export function parseDebtModelStrict(formData: FormData): DebtModelResult {
  const raw = String(formData.get("debtModel") ?? "").trim();

  if (!raw) {
    return { ok: true, model: null };
  }

  if (raw === "amortizable" || raw === "revolving" || raw === "informal") {
    return { ok: true, model: raw };
  }

  return { ok: false, error: "El modelo de deuda no es válido." };
}

/**
 * Convert a user-typed annual percentage (e.g. "3", es-ES "2,5") into the
 * decimal string the store persists ("0.03", "0.025"). Rejects a blank or
 * negative value. Mirrors the percent→decimal logic of parseAppreciationRateStrict.
 */
function parseAnnualRatePercent(
  raw: string,
): { ok: true; rate: DecimalString } | { ok: false } {
  const pct = parseDecimalStrict(raw.trim());

  if (pct === null || pct < 0) {
    return { ok: false };
  }

  const decimal = pct / 100;
  const rate = (
    Number.isInteger(decimal) ? String(decimal) : decimal.toString()
  ) as DecimalString;

  return { ok: true, rate };
}

/**
 * Strict amortization-plan parser (PRD #109, slice 10). Builds a
 * CreateAmortizationPlanInput from the plan form. Validates server-side: a
 * positive initial capital (EUR → minor), a non-negative annual interest rate
 * (% → decimal string), a positive whole-month term, and a present, ISO,
 * non-future start date (a future start would generate no history). The caller
 * redirects on error.
 */
export function parseAmortizationPlanStrict(
  formData: FormData,
  liabilityId: string,
  seed: number,
  today: string,
): StrictParseResult<CreateAmortizationPlanInput> {
  const initialCapitalMinor = parseMoneyMinorField(formData, "initialCapital");

  if (initialCapitalMinor === null || initialCapitalMinor <= 0) {
    return { ok: false, error: "El capital inicial debe ser un número positivo." };
  }

  const rate = parseAnnualRatePercent(String(formData.get("annualInterestRate") ?? ""));

  if (!rate.ok) {
    return { ok: false, error: "El tipo de interés anual no es válido." };
  }

  const termMonths = parseDecimalStrict(String(formData.get("termMonths") ?? ""));

  if (termMonths === null || !Number.isInteger(termMonths) || termMonths <= 0) {
    return {
      ok: false,
      error: "El plazo debe ser un número entero de meses mayor que cero.",
    };
  }

  const startDate = String(formData.get("startDate") ?? "").trim();

  if (!startDate) {
    return { ok: false, error: "La fecha de inicio es obligatoria." };
  }

  if (!ISO_DATE.test(startDate)) {
    return { ok: false, error: "La fecha de inicio no es válida." };
  }

  if (startDate > today) {
    return { ok: false, error: "La fecha no puede ser futura." };
  }

  return {
    ok: true,
    command: {
      annualInterestRate: rate.rate,
      id: createStableId("plan", liabilityId, seed),
      initialCapitalMinor,
      liabilityId,
      startDate,
      termMonths,
    },
  };
}

/**
 * Strict interest-rate-revision parser (PRD #109, slice 10). Builds an
 * AddInterestRateRevisionInput from the revision form: a present, ISO,
 * non-future date and a non-negative annual rate (% → decimal string). The
 * caller redirects on error.
 */
export function parseInterestRateRevisionStrict(
  formData: FormData,
  planId: string,
  seed: number,
  today: string,
): StrictParseResult<AddInterestRateRevisionInput> {
  const revisionDate = String(formData.get("revisionDate") ?? "").trim();

  if (!revisionDate) {
    return { ok: false, error: "La fecha de la revisión es obligatoria." };
  }

  if (!ISO_DATE.test(revisionDate)) {
    return { ok: false, error: "La fecha de la revisión no es válida." };
  }

  if (revisionDate > today) {
    return { ok: false, error: "La fecha no puede ser futura." };
  }

  const rate = parseAnnualRatePercent(
    String(formData.get("newAnnualInterestRate") ?? ""),
  );

  if (!rate.ok) {
    return { ok: false, error: "El nuevo tipo de interés no es válido." };
  }

  return {
    ok: true,
    command: {
      id: createStableId("rev", planId, seed),
      newAnnualInterestRate: rate.rate,
      planId,
      revisionDate,
    },
  };
}

/**
 * Strict balance-anchor parser (PRD #109, slice 10). Builds an
 * AddBalanceAnchorInput for a revolving/informal debt: a present, ISO,
 * non-future date and a positive total balance (EUR → minor, interest already
 * included — there is no separate flag, slice #117 decision). The caller
 * redirects on error.
 */
export function parseBalanceAnchorStrict(
  formData: FormData,
  liabilityId: string,
  seed: number,
  today: string,
): StrictParseResult<AddBalanceAnchorInput> {
  const anchorDate = String(formData.get("anchorDate") ?? "").trim();

  if (!anchorDate) {
    return { ok: false, error: "La fecha del saldo es obligatoria." };
  }

  if (!ISO_DATE.test(anchorDate)) {
    return { ok: false, error: "La fecha del saldo no es válida." };
  }

  if (anchorDate > today) {
    return { ok: false, error: "La fecha no puede ser futura." };
  }

  const balanceMinor = parseMoneyMinorField(formData, "balance");

  if (balanceMinor === null || balanceMinor <= 0) {
    return { ok: false, error: "El saldo debe ser un número positivo." };
  }

  return {
    ok: true,
    command: {
      anchorDate,
      balanceMinor,
      id: createStableId("banchor", liabilityId, seed),
      liabilityId,
    },
  };
}

/**
 * Strict early-repayment parser (PRD #146, slice S4). Builds an
 * AddEarlyRepaymentInput: a present, ISO, non-future date, a positive amount
 * (EUR → minor), and a mode — reduce-payment keeps the term and lowers the
 * cuota, reduce-term keeps the cuota and shortens the term. The caller redirects
 * on error.
 */
export function parseEarlyRepaymentStrict(
  formData: FormData,
  planId: string,
  seed: number,
  today: string,
): StrictParseResult<AddEarlyRepaymentInput> {
  const repaymentDate = String(formData.get("repaymentDate") ?? "").trim();

  if (!repaymentDate) {
    return { ok: false, error: "La fecha de la amortización es obligatoria." };
  }

  if (!ISO_DATE.test(repaymentDate)) {
    return { ok: false, error: "La fecha de la amortización no es válida." };
  }

  if (repaymentDate > today) {
    return { ok: false, error: "La fecha no puede ser futura." };
  }

  const amountMinor = parseMoneyMinorField(formData, "amount");

  if (amountMinor === null || amountMinor <= 0) {
    return { ok: false, error: "El importe debe ser un número positivo." };
  }

  const mode = String(formData.get("mode") ?? "").trim();

  if (mode !== "reduce-payment" && mode !== "reduce-term") {
    return { ok: false, error: "El tipo de amortización no es válido." };
  }

  return {
    ok: true,
    command: {
      amountMinor,
      id: createStableId("erp", planId, seed),
      mode,
      planId,
      repaymentDate,
    },
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
  if (value === "market" || value === "term-locked" || value === "illiquid") {
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
export function parseEmpezarSolo(
  formData: FormData,
): StrictParseResult<WorkspaceInitCommand> {
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
export function parseEmpezarHogar(
  formData: FormData,
): StrictParseResult<WorkspaceInitCommand> {
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
        error:
          "El precio manual no es válido. Introduce un número positivo o déjalo en blanco.",
      };
    }

    if (normalized !== "0") {
      manualPrice = normalized as DecimalString;
    }
  }

  const unitSymbol = String(formData.get("unitSymbol") ?? "").trim();
  const isin = String(formData.get("isin") ?? "").trim();
  const liquidityTier = parseCreateInvestmentLiquidityTier(formData.get("liquidityTier"));
  const priceProvider = parseInvestmentPriceProvider(formData.get("priceProvider"));
  const providerSymbol = String(formData.get("providerSymbol") ?? "").trim();

  if (!liquidityTier) {
    return { ok: false, error: "La liquidez de la inversión no es válida." };
  }

  if (priceProvider === null) {
    return { ok: false, error: "El proveedor de precios no es válido." };
  }

  return {
    ok: true,
    command: {
      currency: "EUR",
      id: createStableId("asset", name, seed),
      liquidityTier,
      name,
      ownership: parseOwnership(formData, members),
      ...(manualPrice !== undefined ? { manualPricePerUnit: manualPrice } : {}),
      ...(unitSymbol ? { unitSymbol } : {}),
      ...(isin ? { isin } : {}),
      ...(priceProvider ? { priceProvider } : {}),
      ...(providerSymbol ? { providerSymbol } : {}),
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
): StrictParseResult<{
  id: string;
  name: string;
  liquidityTier?: LiquidityTier;
  unitSymbol?: string;
  isin?: string;
  priceProvider?: InvestmentPriceProvider;
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
}> {
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
        error:
          "El precio manual no es válido. Introduce un número positivo o déjalo en blanco.",
      };
    }

    if (normalized !== "0") {
      manualPrice = normalized as DecimalString;
    }
  }

  const unitSymbol = String(formData.get("unitSymbol") ?? "").trim();
  const isin = String(formData.get("isin") ?? "").trim();
  const liquidityTier = parseUpdateInvestmentLiquidityTier(formData.get("liquidityTier"));
  const priceProvider = parseInvestmentPriceProvider(formData.get("priceProvider"));
  const providerSymbol = String(formData.get("providerSymbol") ?? "").trim();

  if (liquidityTier === null) {
    return { ok: false, error: "La liquidez de la inversión no es válida." };
  }

  if (priceProvider === null) {
    return { ok: false, error: "El proveedor de precios no es válido." };
  }

  return {
    ok: true,
    command: {
      id: assetId,
      name,
      ...(liquidityTier ? { liquidityTier } : {}),
      ...(manualPrice !== undefined ? { manualPricePerUnit: manualPrice } : {}),
      ...(unitSymbol ? { unitSymbol } : {}),
      ...(isin ? { isin } : {}),
      ...(priceProvider ? { priceProvider } : {}),
      ...(providerSymbol ? { providerSymbol } : {}),
    },
  };
}

function parseCreateInvestmentLiquidityTier(
  value: FormDataEntryValue | null,
): LiquidityTier | null {
  const raw = String(value ?? "").trim();
  if (!raw) return "market";

  return isLiquidityTier(raw) ? raw : null;
}

function parseUpdateInvestmentLiquidityTier(
  value: FormDataEntryValue | null,
): LiquidityTier | null | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  return isLiquidityTier(raw) ? raw : null;
}

function isLiquidityTier(value: string): value is LiquidityTier {
  return (
    value === "cash" ||
    value === "market" ||
    value === "term-locked" ||
    value === "illiquid"
  );
}

function parseInvestmentPriceProvider(
  value: FormDataEntryValue | null,
): InvestmentPriceProvider | null | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  return raw === "yahoo" || raw === "stooq" || raw === "finect" ? raw : null;
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

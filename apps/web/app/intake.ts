import type {
  CompositionHousingMode,
  CompositionRange,
  DomainViolation,
  DrilldownKey,
  NetWorthFraming,
  PortfolioGroupKey,
  PriceFreshnessState,
} from "@worthline/domain";
import { PORTFOLIO_GROUP_KEYS } from "@worthline/domain";

import { PRESERVED_VALUE_PREFIX } from "./current-url";

export { buildCurrentUrl, buildCurrentUrlFor } from "./current-url";

/**
 * The web intake seam: turns raw HTML form input into validated domain command
 * objects and parses request params. Pure and framework-agnostic (no Next.js),
 * so it can be unit-tested without the runtime and reused by other clients.
 * Domain invariants stay in the domain constructors — intake only shapes input.
 *
 * Since #241 stage 2, the per-instrument PARSERS live in their own family
 * modules under `./intake/`; this file keeps the URL/redirect/query-param web
 * helpers and acts as the public barrel that re-exports the complete surface so
 * no consumer import has to change. To add a new instrument: drop a new file
 * under `./intake/` (composed from `./intake-primitives` + `./intake/shared`)
 * and add a one-line re-export below — no edit to the other families.
 */

// === #241 barrel: re-export the per-instrument parser families ===

export {
  type AppreciationRateResult,
  type HousingCreationData,
  parseAppreciationRateStrict,
  parseAssetCommandStrict,
  parseValuationAnchorStrict,
} from "./intake/asset";
export {
  type DebtModelResult,
  parseAmortizationPlanStrict,
  parseBalanceAnchorStrict,
  parseDebtModelStrict,
  parseEarlyRepaymentStrict,
  parseInterestRateRevisionStrict,
  parseLiabilityCommand,
  parseValuationCadenceStrict,
  type ValuationCadenceResult,
} from "./intake/debt";
export { parseFireConfigFormStrict } from "./intake/fire";
export {
  type CreateInvestmentAssetInput,
  parseInvestmentAssetCommandStrict,
  parseRouteOperationCommand,
  parseUpdateInvestmentCommand,
} from "./intake/investment";
export {
  createStableId,
  parseEntityId,
  parseMoneyMinorField,
  parseOwnership,
  type StrictParseResult,
} from "./intake/shared";
export {
  parseEmpezarHogar,
  parseEmpezarSolo,
  parseNewMember,
  parseValueUpdatePass,
  parseWorkspaceInit,
  type ValueUpdateCommand,
  type WorkspaceInitCommand,
} from "./intake/workspace";

// Re-export the intake primitives so existing consumers that import them from
// `./intake` keep working (stage 1 of #241: extract + route through primitives).
export {
  ISO_DATE,
  normalizeDecimalString,
  normalizeNonNegativeDecimalString,
  type OwnershipPreset,
  parseIsoDateField,
  parseMoneyMinor,
  parsePercentToDecimal,
  resolveOwnershipSplit,
  type ShortfallCompletion,
} from "./intake-primitives";

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

/**
 * Parse the `vivienda=` query param: how the composition chart presents the
 * Vivienda band. Only `oculta` activates the hidden mode; anything else
 * (including the default omitted value) means the net-equity default. Persisted
 * in the URL (ADR 0009) so the choice survives range/view/drill navigation.
 * Composable with `view=`, `drill=` and `range=`.
 */
export function parseViviendaParam(
  value: string | string[] | undefined,
): CompositionHousingMode {
  return normalizeParam(value) === "oculta" ? "hidden" : "net";
}

/**
 * Parse the `group=` query param (#154, PRD #146 S8): how the unified /patrimonio
 * holdings list is grouped. Only the three known axes activate; anything else
 * (including the default) means `direction` (Activos/Pasivos). The selected group
 * doubles as the filter, server-side — no client JS (ADR 0009).
 */
export function parseGroupParam(value: string | string[] | undefined): PortfolioGroupKey {
  const raw = normalizeParam(value);

  return PORTFOLIO_GROUP_KEYS.includes(raw as PortfolioGroupKey)
    ? (raw as PortfolioGroupKey)
    : "direction";
}

export function isLocalRedirectPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
}

export function localRedirectPath(
  value: string | null | undefined,
  fallback = "/",
): string {
  const raw = String(value ?? "").trim();

  return isLocalRedirectPath(raw) ? raw : fallback;
}

/** Set or replace a query param on a local URL string. */
export function appendParam(url: string, key: string, value: string): string {
  const safeUrl = localRedirectPath(url);
  const hashIndex = safeUrl.indexOf("#");
  const beforeHash = hashIndex === -1 ? safeUrl : safeUrl.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : safeUrl.slice(hashIndex);
  const [path, query = ""] = beforeHash.split("?");
  const params = new URLSearchParams(query);
  params.set(key, value);
  const qs = params.toString();

  const next = qs ? `${path ?? "/"}?${qs}` : (path ?? "/");

  return `${next}${hash}`;
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

/**
 * Build the success redirect for a statement load (#174), carrying the created /
 * skipped counts so the banner can summarize what changed.
 */
export function statementLoadedRedirectUrl(
  currentUrl: string,
  summary: {
    created: number;
    overwritten: number;
    skipped: number;
    anomalies: number;
    sells: number;
  },
): string {
  let url = appendParam(currentUrl, "ok", "statement_loaded");
  url = appendParam(url, "created", String(summary.created));
  url = appendParam(url, "overwritten", String(summary.overwritten));
  url = appendParam(url, "skipped", String(summary.skipped));
  url = appendParam(url, "anomalies", String(summary.anomalies));
  url = appendParam(url, "sells", String(summary.sells));

  return url;
}

/**
 * Build the success redirect for a historical-price backfill (#380, ADR 0033),
 * carrying the SOURCE so the post-confirm banner records which provider/CSV
 * produced the frozen prices (criterion 8 — durable-ish audit trail in the URL,
 * not just the pre-confirm preview).
 */
export function priceBackfillDoneRedirectUrl(currentUrl: string, source: string): string {
  return appendParam(
    appendParam(currentUrl, "ok", "price_backfill_done"),
    "source",
    source,
  );
}

/** Success redirect for a single-date snapshot price correction (#926). */
export function snapshotPriceCorrectionDoneRedirectUrl(
  currentUrl: string,
  dateKey: string,
): string {
  return appendParam(
    appendParam(currentUrl, "ok", "snapshot_price_corrected"),
    "date",
    dateKey,
  );
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

  if (key === "statement_loaded") {
    const created =
      Number.parseInt(normalizeParam(searchParams?.["created"]) ?? "", 10) || 0;
    const overwritten =
      Number.parseInt(normalizeParam(searchParams?.["overwritten"]) ?? "", 10) || 0;
    const skipped =
      Number.parseInt(normalizeParam(searchParams?.["skipped"]) ?? "", 10) || 0;
    const anomalies =
      Number.parseInt(normalizeParam(searchParams?.["anomalies"]) ?? "", 10) || 0;
    const sells = Number.parseInt(normalizeParam(searchParams?.["sells"]) ?? "", 10) || 0;
    const createdPart = `${created} ${created === 1 ? "movimiento creado" : "movimientos creados"}`;
    const overwrittenPart =
      overwritten > 0
        ? ` · ${overwritten} actualizado${overwritten === 1 ? "" : "s"}`
        : "";
    const skippedPart =
      skipped > 0 ? ` · ${skipped} omitido${skipped === 1 ? "" : "s"}` : "";
    const sellsPart =
      sells > 0
        ? ` · ${sells} venta${sells === 1 ? "" : "s"} detectada${sells === 1 ? "" : "s"}`
        : "";
    const anomalyPart =
      anomalies > 0 ? ` · ${anomalies} con fecha duplicada sin tocar` : "";

    return `${createdPart}${overwrittenPart}${sellsPart}${skippedPart}${anomalyPart}.`;
  }

  if (key === "statement_import_loaded") {
    const funds = Number.parseInt(normalizeParam(searchParams?.["funds"]) ?? "", 10) || 0;
    const created =
      Number.parseInt(normalizeParam(searchParams?.["created"]) ?? "", 10) || 0;
    const createdPart =
      created > 0 ? ` (${created} nuevo${created === 1 ? "" : "s"})` : "";
    return `${funds} fondo${funds === 1 ? "" : "s"} importado${funds === 1 ? "" : "s"}${createdPart}.`;
  }

  if (key === "price_backfill_done") {
    // Surface the source that produced the frozen prices so the post-confirm
    // banner — not just the preview — carries the audit trail (#380, criterion 8).
    const source = normalizeParam(searchParams?.["source"]);
    return source ? `Histórico de precios rellenado desde ${source}.` : okMessage(key);
  }

  if (key === "snapshot_price_corrected") {
    const dateKey = normalizeParam(searchParams?.["date"]);
    return dateKey ? `Snapshot del ${dateKey} corregido.` : okMessage(key);
  }

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
    balance_history_imported: "Historial de saldos importado.",
    binance_connected: "Cuenta de Binance conectada.",
    binance_disconnected: "Cuenta de Binance desconectada.",
    binance_frozen: "Cuenta de Binance convertida en activo manual.",
    binance_synced: "Cuenta de Binance sincronizada.",
    current_state_debt_saved: "Deuda dada de alta por estado actual.",
    debt_model_saved: "Modelo de deuda guardado.",
    debt_recalibrated: "Deuda recalibrada con el saldo real.",
    deleted_recoverable: "Eliminado — recuperable en Papelera.",
    fire_saved: "Configuración FIRE guardada.",
    hard_deleted: "Eliminado definitivamente.",
    investment_added: "Inversión añadida.",
    investment_import_ready:
      "Inversión creada. Ahora carga el extracto para añadir sus movimientos.",
    liability_added: "Deuda añadida.",
    member_deleted: "Miembro borrado definitivamente.",
    numista_connected: "Colección Numista conectada.",
    numista_disconnected: "Colección Numista desconectada.",
    numista_frozen: "Colección convertida en activo manual.",
    numista_synced: "Colección Numista sincronizada.",
    operation_deleted: "Operación eliminada.",
    payout_saved: "Cobro registrado.",
    payout_deleted: "Cobro eliminado.",
    payout_schedule_saved: "Cobro recurrente guardado.",
    payout_schedule_updated: "Cobro recurrente actualizado.",
    payout_schedule_deleted: "Cobro recurrente eliminado.",
    plan_deleted: "Plan de amortización eliminado.",
    plan_saved: "Plan de amortización guardado.",
    price_backfill_done: "Histórico de precios rellenado.",
    snapshot_price_corrected: "Snapshot corregido.",
    prices_refreshed: "Precios actualizados.",
    repayment_added: "Amortización anticipada registrada.",
    repayment_deleted: "Amortización anticipada eliminada.",
    repayment_saved: "Amortización anticipada actualizada.",
    rate_saved: "Tasa de revalorización guardada.",
    revision_added: "Revisión de tipo registrada.",
    revision_deleted: "Revisión de tipo eliminada.",
    revision_saved: "Revisión de tipo actualizada.",
    goal_deleted: "Objetivo eliminado.",
    goal_saved: "Objetivo guardado.",
    restored: "Restaurado.",
    saved: "Guardado.",
    trash_emptied: "Papelera vaciada.",
    valores_actualizados: "Valores actualizados.",
    valuation_cadence_saved: "Cadencia de valoración guardada.",
    warning_acknowledged: "Aviso marcado como intencional.",
  };

  // === #57 patrimonio ===

  return messages[key] ?? null;
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
    case "connected_manual_valuation_rejected":
      return "El valor de un activo conectado se actualiza al sincronizar — no puedes fijarlo a mano.";
    case "value_update_investment_holding":
      return "Las inversiones no se pueden actualizar en la puesta al día — su valor es siempre calculado.";
    case "duplicate_primary_residence":
      return `Ya hay una vivienda habitual («${violation.existingName}»). Solo puede haber una — desmárcala primero.`;
  }
}

/**
 * The name of the HTTP cookie that persists the active scope across pages and
 * sessions. Value is a raw scope ID string (member ID or "household").
 */
export const SCOPE_COOKIE_NAME = "wl_scope";

/**
 * The name of the HTTP cookie that persists privacy mode across pages and
 * sessions. Value is "1" when enabled, anything else (or absent) means off.
 */
export const PRIVACY_COOKIE_NAME = "wl_privacy";

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

/**
 * Parse the privacy cookie value to a boolean.
 * Returns true only for the exact value "1".
 */
export function parsePrivacyCookie(cookieValue: string | undefined): boolean {
  if (!cookieValue) {
    return false;
  }

  return cookieValue.trim() === "1";
}

function normalizeParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

// === #58 inversiones ===

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

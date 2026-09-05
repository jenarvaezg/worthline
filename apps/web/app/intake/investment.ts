import {
  normalizeDecimalString,
  normalizeNonNegativeDecimalString,
  parseMoneyMinor,
} from "@web/intake-primitives";
import type { CreateInvestmentAssetInput } from "@worthline/db";
import type {
  CreateInvestmentOperationInput,
  DecimalString,
  Instrument,
  InvestmentPriceProvider,
  LiquidityTier,
  Member,
  OperationKind,
  SecurityId,
} from "@worthline/domain";
import {
  isAssignableInstrumentForShape,
  isCaptureCurrency,
  isInstrument,
  isInvestmentPriceProvider,
  isValidIsin,
} from "@worthline/domain";
import { createStableId, parseOwnership, type StrictParseResult } from "./shared";

/**
 * Investment intake parsers (#241 stage 2). Turns the /inversiones/nueva,
 * route-scoped operation, and edit-investment forms into validated domain
 * command objects. Pure and framework-agnostic.
 */

// Re-export the type needed by #58 inversiones functions and consumers.
export type { CreateInvestmentAssetInput };

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
    const normalized = normalizeNonNegativeDecimalString(manualPriceRaw);

    if (normalized === null) {
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
  const isin = parseOptionalIsin(formData.get("isin"));
  const liquidityTier = parseCreateInvestmentLiquidityTier(formData.get("liquidityTier"));
  const priceProvider = parseInvestmentPriceProvider(formData.get("priceProvider"));
  const providerSymbol = String(formData.get("providerSymbol") ?? "").trim();

  if (!isin.ok) {
    return { ok: false, error: isin.error };
  }

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
      ...(isin.isin ? { securityId: { kind: "isin", value: isin.isin } } : {}),
      ...(priceProvider ? { priceProvider } : {}),
      ...(providerSymbol ? { providerSymbol } : {}),
    },
  };
}

/**
 * The ISIN a form carries, normalized — or a refusal (#1489).
 *
 * Two jobs, both boundary work. It UPPERCASES and strips whitespace, because the ISIN is
 * the instrument's identity key (`isin ?? providerSymbol`, ADR 0055/#539) and it is
 * compared as text: `ie00b52mjy50` typed by hand would be a second identity for the same
 * ETF, invisible to the statement merge and to the exposure catalog. And it REFUSES a
 * value that fails the ISO 6166 check digit, which the field could not produce while it
 * was a hidden input the symbol search filled — a human types now, and a stored typo is
 * an identity that will never match anything, silently, forever.
 *
 * Blank stays blank: the ISIN is optional by design (a pension plan often has none), and
 * an alta that leaves it empty is flagged by the health signal, never blocked.
 *
 * Exported because the alta is no longer the only door an ISIN comes through: the
 * traspaso form creates its destination holding in the same submit (#1480), and a
 * second reading of the same field would be a second identity rule.
 */
export function parseOptionalIsin(
  value: FormDataEntryValue | null,
): { ok: true; isin?: string } | { ok: false; error: string } {
  const normalized = String(value ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();

  if (!normalized) {
    return { ok: true };
  }

  if (!isValidIsin(normalized)) {
    return {
      ok: false,
      error:
        "El ISIN no es válido. Son 12 caracteres (p. ej. IE00B52MJY50); revísalo o déjalo en blanco.",
    };
  }

  return { ok: true, isin: normalized };
}

/**
 * Route-scoped operation parser: the asset id comes from the URL route
 * (not a dropdown), preventing silent no-op on unselected dropdown.
 * Never silently swallows a bad units/price/fees field — returns an error
 * that names the offending field.
 *
 * `seed` is what makes the operation id unique. A clock reading gives a fresh id
 * per call; an idempotency key (#1394) gives the SAME id for the same submission,
 * which is how a double submit stops becoming two operations.
 */
export function parseRouteOperationCommand(
  formData: FormData,
  routeAssetId: string,
  seed: number | string,
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

  const normalizeOperationDecimal = (raw: string): DecimalString =>
    normalizeDecimalString(raw, { allowNegative: true, fallback: "0" }) as DecimalString;

  const units = normalizeOperationDecimal(unitsRaw);
  const pricePerUnit = normalizeOperationDecimal(priceRaw);

  if (units === "0") {
    return { ok: false, error: "Las unidades deben ser un número positivo." };
  }

  if (pricePerUnit === "0" && priceRaw !== "0" && priceRaw !== "0,00") {
    return { ok: false, error: "El precio por unidad no es válido." };
  }

  const feesRaw = String(formData.get("fees") ?? "0");
  const feesMinor = parseMoneyMinor(feesRaw);

  if (feesMinor === null || feesMinor < 0) {
    return { ok: false, error: "Las comisiones no son válidas." };
  }

  const kind: OperationKind = formData.get("kind") === "sell" ? "sell" : "buy";
  const executedAt = String(formData.get("executedAt") ?? "").trim() || today;

  // The currency the apunte was CAPTURED in (#1401). A blank field is EUR — the
  // pre-#1401 behavior, byte for byte, which is what keeps the no-JS path and every
  // caller that never asks working unchanged. Anything outside the closed vocabulary
  // is refused rather than coerced: a currency the money model cannot represent would
  // mangle the fees by ×100 in silence.
  //
  // Nothing is converted here. This parser is pure and the ECB rate is a fetch, so it
  // stamps what was typed and `recordOperationAction` converts before persisting.
  const currency = String(formData.get("currency") ?? "").trim() || "EUR";

  if (!isCaptureCurrency(currency)) {
    return { ok: false, error: "Esa divisa no es válida para una operación." };
  }

  return {
    ok: true,
    command: {
      assetId: routeAssetId,
      currency,
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
  instrument?: Instrument;
  liquidityTier?: LiquidityTier;
  unitSymbol?: string;
  securityId?: SecurityId;
  priceProvider?: InvestmentPriceProvider;
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
}> {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { ok: false, error: "El nombre de la inversión es obligatorio." };
  }

  // #1512: the ficha may correct the instrument, but only within the shape it
  // already has. This route serves the `investment` shape by construction (the
  // ficha dispatches on the valuation method), so it asks the same domain gate as
  // the asset action, keyed by that shape instead of by a row it cannot read.
  const instrumentRaw = String(formData.get("instrument") ?? "").trim();
  if (
    instrumentRaw &&
    (!isInstrument(instrumentRaw) ||
      !isAssignableInstrumentForShape("investment", instrumentRaw))
  ) {
    return {
      ok: false,
      error:
        "No se puede reclasificar a ese tipo: se valora de otra forma. Para eso hay que darlo de alta de nuevo.",
    };
  }
  const instrument = isInstrument(instrumentRaw) ? instrumentRaw : undefined;

  const manualPriceRaw = String(formData.get("manualPricePerUnit") ?? "").trim();
  let manualPrice: DecimalString | undefined;

  if (manualPriceRaw) {
    const normalized = normalizeNonNegativeDecimalString(manualPriceRaw);

    if (normalized === null) {
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
  const isin = parseOptionalIsin(formData.get("isin"));
  const liquidityTier = parseUpdateInvestmentLiquidityTier(formData.get("liquidityTier"));
  const priceProvider = parseInvestmentPriceProvider(formData.get("priceProvider"));
  const providerSymbol = String(formData.get("providerSymbol") ?? "").trim();

  if (!isin.ok) {
    return { ok: false, error: isin.error };
  }

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
      ...(instrument ? { instrument } : {}),
      ...(liquidityTier ? { liquidityTier } : {}),
      ...(manualPrice !== undefined ? { manualPricePerUnit: manualPrice } : {}),
      ...(unitSymbol ? { unitSymbol } : {}),
      ...(isin.isin ? { securityId: { kind: "isin", value: isin.isin } } : {}),
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

/**
 * Parse a submitted price provider: `undefined` for an absent field, `null` for a
 * value outside the vocabulary. Accepts RETIRED providers (#1354) on purpose —
 * the edit form re-submits whatever a legacy holding already carries, and
 * rejecting it here would refuse a save that changes something else entirely.
 * The retired provider simply never fetches (see `retiredPriceProvider`).
 */
function parseInvestmentPriceProvider(
  value: FormDataEntryValue | null,
): InvestmentPriceProvider | null | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  return isInvestmentPriceProvider(raw) ? raw : null;
}

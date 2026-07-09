import {
  normalizeDecimalString,
  normalizeNonNegativeDecimalString,
  parseMoneyMinor,
} from "@web/intake-primitives";
import type { CreateInvestmentAssetInput } from "@worthline/db";
import type {
  CreateInvestmentOperationInput,
  DecimalString,
  InvestmentPriceProvider,
  LiquidityTier,
  Member,
  OperationKind,
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

  return raw === "yahoo" || raw === "stooq" || raw === "finect" || raw === "coingecko"
    ? raw
    : null;
}

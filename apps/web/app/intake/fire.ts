import type { FireScopeConfig } from "@worthline/domain";
import { parseDecimalStrict } from "@worthline/domain";

import { parseMoneyMinor } from "@web/intake-primitives";
import type { StrictParseResult } from "./shared";

/**
 * FIRE config intake parser (#241 stage 2). Turns the FIRE settings form into a
 * validated FireScopeConfig. Pure and framework-agnostic.
 */

/**
 * Strict FIRE config parser: rejects garbage inputs (zero/negative spending,
 * zero rates) instead of silently producing a config that yields "FIRE alcanzado"
 * from invalid data. Returns an error describing the first invalid field.
 */
export function parseFireConfigFormStrict(
  formData: FormData,
): StrictParseResult<FireScopeConfig> {
  const monthlySpendingRaw = (formData.get("monthlySpending") as string) ?? "";
  const monthlySpendingMinor = parseMoneyMinor(monthlySpendingRaw);

  if (monthlySpendingMinor === null || monthlySpendingMinor <= 0) {
    return {
      ok: false,
      error: "El gasto mensual debe ser un número positivo.",
    };
  }

  const safeWithdrawalRateRaw = (formData.get("safeWithdrawalRate") as string) ?? "";
  const safeWithdrawalRatePct = parseDecimalStrict(safeWithdrawalRateRaw);

  if (!safeWithdrawalRatePct || safeWithdrawalRatePct <= 0) {
    return {
      ok: false,
      error: "La tasa de retirada segura debe ser un número positivo.",
    };
  }

  // N3 (#515): expectedRealReturn is now an OPTIONAL override. Empty → use
  // weighted tier-mix effective rate. Non-empty → validate positive.
  const expectedRealReturnRaw = (
    (formData.get("expectedRealReturn") as string) ?? ""
  ).trim();
  const hasExpectedRealReturn = expectedRealReturnRaw.length > 0;
  const expectedRealReturnPct = hasExpectedRealReturn
    ? parseDecimalStrict(expectedRealReturnRaw)
    : null;

  if (hasExpectedRealReturn && (!expectedRealReturnPct || expectedRealReturnPct <= 0)) {
    return {
      ok: false,
      error: "El retorno real esperado, si se indica, debe ser un número positivo.",
    };
  }

  // Per-tier real return overrides (N3, #515): optional fields for each eligible tier.
  const parseTierReturn = (name: string): number | undefined => {
    const raw = ((formData.get(name) as string) ?? "").trim();
    if (!raw) return undefined;
    const parsed = parseDecimalStrict(raw);
    // ponytail: >= 0 so cash (0%) is a valid explicit override
    return parsed !== null && parsed >= 0 ? parsed / 100 : undefined;
  };
  const tierCash = parseTierReturn("tierReturn_cash");
  const tierMarket = parseTierReturn("tierReturn_market");
  const tierTermLocked = parseTierReturn("tierReturn_term-locked");
  const tierIlliquid = parseTierReturn("tierReturn_illiquid");
  const hasTierOverrides =
    tierCash !== undefined ||
    tierMarket !== undefined ||
    tierTermLocked !== undefined ||
    tierIlliquid !== undefined;
  const tierRealReturns = hasTierOverrides
    ? {
        ...(tierCash !== undefined ? { cash: tierCash } : {}),
        ...(tierMarket !== undefined ? { market: tierMarket } : {}),
        ...(tierTermLocked !== undefined ? { "term-locked": tierTermLocked } : {}),
        ...(tierIlliquid !== undefined ? { illiquid: tierIlliquid } : {}),
      }
    : undefined;

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

  // Monthly savings capacity (#425) is optional: a blank or garbage value leaves
  // it unset so the UI's suggestion-from-history can fill it. Zero is valid — it
  // means "not saving right now" — so we keep it. Negative is nonsense → drop it.
  const monthlySavingsCapacityRaw =
    (formData.get("monthlySavingsCapacity") as string) ?? "";
  const monthlySavingsCapacityMinor = parseMoneyMinor(monthlySavingsCapacityRaw);
  const hasSavingsCapacity =
    monthlySavingsCapacityMinor !== null && monthlySavingsCapacityMinor >= 0;

  // Lean/Fat multipliers (PRD #507 N1): optional. Blank/garbage → undefined (defaults 0.7/1.5).
  // When provided, both must be present and satisfy 0 < lean < fat ≤ 10.
  const leanMultiplierRaw = ((formData.get("leanMultiplier") as string) ?? "").trim();
  const fatMultiplierRaw = ((formData.get("fatMultiplier") as string) ?? "").trim();
  const leanMultiplierParsed = leanMultiplierRaw
    ? parseDecimalStrict(leanMultiplierRaw)
    : null;
  const fatMultiplierParsed = fatMultiplierRaw
    ? parseDecimalStrict(fatMultiplierRaw)
    : null;
  const hasLean = leanMultiplierParsed !== null;
  const hasFat = fatMultiplierParsed !== null;

  // If either is provided, validate both together.
  if (hasLean || hasFat) {
    const lean = leanMultiplierParsed ?? 0.7;
    const fat = fatMultiplierParsed ?? 1.5;
    if (lean <= 0 || fat <= 0 || lean >= fat || fat > 10) {
      return {
        ok: false,
        error:
          "Los multiplicadores Lean/Fat deben cumplir: 0 < Lean < Fat ≤ 10 (por defecto 0,7 / 1,5).",
      };
    }
  }

  const leanMultiplier = hasLean ? leanMultiplierParsed! : undefined;
  const fatMultiplier = hasFat ? fatMultiplierParsed! : undefined;

  // Barista income (N2, #514): optional. 0/empty/negative → undefined (no effect).
  const baristaIncomeRaw = (formData.get("baristaIncome") as string) ?? "";
  const baristaIncomeMinor = parseMoneyMinor(baristaIncomeRaw);
  const hasBaristaIncome = baristaIncomeMinor !== null && baristaIncomeMinor > 0;

  return {
    ok: true,
    command: {
      excludedAssetIds: [],
      ...(hasExpectedRealReturn && expectedRealReturnPct
        ? { expectedRealReturn: expectedRealReturnPct / 100 }
        : {}),
      monthlySpendingMinor,
      safeWithdrawalRate: safeWithdrawalRatePct / 100,
      targetRetirementAge,
      ...(currentAge !== undefined ? { currentAge } : {}),
      ...(hasSavingsCapacity ? { monthlySavingsCapacityMinor } : {}),
      ...(leanMultiplier !== undefined ? { leanMultiplier } : {}),
      ...(fatMultiplier !== undefined ? { fatMultiplier } : {}),
      ...(hasBaristaIncome ? { baristaMonthlyIncomeMinor: baristaIncomeMinor! } : {}),
      ...(tierRealReturns ? { tierRealReturns } : {}),
    },
  };
}

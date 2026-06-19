import type { FireScopeConfig } from "@worthline/domain";
import { parseDecimal } from "@worthline/domain";

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

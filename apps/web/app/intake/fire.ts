import { parseMoneyMinor } from "@web/intake-primitives";
import type { FireRetirementPlan, FireScopeConfig } from "@worthline/domain";
import { ORDINARY_RETIREMENT_AGE_DEFAULT, parseDecimalStrict } from "@worthline/domain";
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

  // No `currentAge` here on purpose (#1415). The reference age is DERIVED from the
  // member's birth date on every read (`withDerivedCurrentAges`, wired into
  // `store.readFireConfig`), because a typed age freezes: the one Jorge entered at
  // 62 still read 62 the year he turned 63, and every projected age drifted a year
  // young. `FireScopeConfig.currentAge` lives on only as the legacy fallback for
  // configs written before this change, and `saveFireConfig` carries that value
  // forward so saving this form never erases it.
  //
  // Y la edad objetivo tampoco la rellenamos nosotros (#1428). Este parser escribía
  // `?? 65` siempre, así que TODA config guardada llevaba un 65 que el usuario no había
  // elegido — y la señal del perfil, que compara esa edad con el umbral (también 65 por
  // defecto), se disparaba para todo el mundo citándole una edad que nunca escribió. El
  // motor sigue cayendo a 65 donde hay que calcular (`calculateFire`,
  // `fireReservationHorizon`); lo que no se hace es GUARDARLO como si fuera una
  // declaración (ADR 0074).
  const targetRetirementAgeRaw = (
    (formData.get("targetRetirementAge") as string | null) ?? ""
  ).trim();
  const targetRetirementAgeParsed = targetRetirementAgeRaw
    ? parseInt(targetRetirementAgeRaw, 10)
    : null;
  const targetRetirementAge =
    targetRetirementAgeParsed !== null && !Number.isNaN(targetRetirementAgeParsed)
      ? targetRetirementAgeParsed
      : undefined;

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

  // La edad a partir de la cual jubilarse ya no es *early* (#1428): un dato del
  // usuario con defecto neutro, nunca la normativa española codificada — la edad
  // ordinaria depende del país y del año (misma doctrina que el tope de #1427).
  const ordinaryRetirementAgeRaw = (
    (formData.get("ordinaryRetirementAge") as string | null) ?? ""
  ).trim();
  const ordinaryRetirementAgeParsed = ordinaryRetirementAgeRaw
    ? parseInt(ordinaryRetirementAgeRaw, 10)
    : null;

  // Con rango, al contrario que `targetRetirementAge` (que no lo tenía ya antes): este
  // umbral es la regla con la que la app mide al usuario, así que un 0 o un 500 guardados
  // en silencio decidirían por él sin que nada en pantalla lo delate.
  if (
    ordinaryRetirementAgeParsed !== null &&
    (Number.isNaN(ordinaryRetirementAgeParsed) ||
      ordinaryRetirementAgeParsed <= 0 ||
      ordinaryRetirementAgeParsed > 130)
  ) {
    return {
      ok: false,
      error: "La edad de jubilación ordinaria debe ser una edad válida.",
    };
  }

  const ordinaryRetirementAge =
    ordinaryRetirementAgeParsed ?? ORDINARY_RETIREMENT_AGE_DEFAULT;

  // La EDAD FINAL: hasta cuándo tiene que durar el capital (#1428). Opcional y SIN
  // defecto aplicado — sin este campo la tarjeta de gasto sostenible enseña solo la
  // versión perpetua. No se llama esperanza de vida a propósito: eso sería una tabla
  // actuarial, y esto es una declaración del usuario.
  const finalAgeRaw = (
    (formData.get("capitalLastsUntilAge") as string | null) ?? ""
  ).trim();
  const finalAgeParsed = finalAgeRaw ? parseInt(finalAgeRaw, 10) : null;
  const hasFinalAge = finalAgeParsed !== null;

  if (hasFinalAge) {
    if (Number.isNaN(finalAgeParsed) || finalAgeParsed <= 0 || finalAgeParsed > 130) {
      return {
        ok: false,
        error: "La edad hasta la que debe durar tu capital debe ser una edad válida.",
      };
    }
    // Un capital que se agota ANTES de la jubilación no responde a ninguna pregunta.
    // Se mide contra la edad objetivo DECLARADA y solo contra ella: rechazar un 60
    // citándole al usuario un 65 que la app rellenó por él es la misma trampa que esta
    // pasada vino a quitar de la señal del perfil (ADR 0074).
    if (targetRetirementAge !== undefined && finalAgeParsed <= targetRetirementAge) {
      return {
        ok: false,
        error:
          "La edad hasta la que debe durar tu capital tiene que ser posterior a tu edad objetivo de jubilación.",
      };
    }
  }

  // La declaración sobre el propio plan (#1428): vacío = sin contestar, y ese es el
  // único estado en el que la pantalla se atreve a ofrecer el cambio. Un valor que no
  // reconocemos se lee como «sin contestar» en vez de rechazar el formulario entero:
  // el campo no es una cifra que el usuario haya tecleado, es una elección de una
  // lista, y perder el resto del guardado por ella sería desproporcionado.
  const retirementPlanRaw = ((formData.get("retirementPlan") as string) ?? "").trim();
  const retirementPlan: FireRetirementPlan | undefined =
    retirementPlanRaw === "ordinary" || retirementPlanRaw === "early"
      ? retirementPlanRaw
      : undefined;

  // Does the immobilized capital count (#1460)? The form pairs the checkbox with a
  // hidden "off", so an UNCHECKED box still arrives — and the absence of BOTH values
  // means a FormData that does not carry the declaration at all, which has to read as
  // the default. Without that distinction the classic checkbox trap («unchecked sends
  // nothing») would let any form that forgets the field silently declare a user's
  // brick out of their FIRE.
  const immobilizedDeclaration = formData.getAll("countImmobilized").map(String);
  const immobilizedCountsAsFireCapital =
    immobilizedDeclaration.length === 0 ? true : immobilizedDeclaration.includes("on");

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
      ...(targetRetirementAge === undefined ? {} : { targetRetirementAge }),
      ...(hasSavingsCapacity ? { monthlySavingsCapacityMinor } : {}),
      ...(leanMultiplier !== undefined ? { leanMultiplier } : {}),
      ...(fatMultiplier !== undefined ? { fatMultiplier } : {}),
      ...(hasBaristaIncome ? { baristaMonthlyIncomeMinor: baristaIncomeMinor! } : {}),
      immobilizedCountsAsFireCapital,
      ordinaryRetirementAge,
      ...(hasFinalAge ? { capitalLastsUntilAge: finalAgeParsed } : {}),
      ...(retirementPlan === undefined ? {} : { retirementPlan }),
      ...(tierRealReturns ? { tierRealReturns } : {}),
    },
  };
}

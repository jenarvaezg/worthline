import type { DecimalString } from "@worthline/domain";
import type { AddValuationAnchorInput } from "@worthline/db";
import type { CreateManualAssetInput, Member } from "@worthline/domain";
import { parseDecimalStrict } from "@worthline/domain";

import { parseIsoDateField, parsePercentToDecimal } from "../intake-primitives";
import {
  createStableId,
  parseMoneyMinorField,
  parseOwnership,
  type StrictParseResult,
} from "./shared";

/**
 * Asset / real-estate intake parsers (#241 stage 2). Turns the «añadir activo»
 * and housing forms into validated domain command objects, composing the shared
 * parse helpers and the field-level primitives. Pure and framework-agnostic.
 */

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
  today: string,
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

  const housingData = parseHousingCreationData(formData, type, today);

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

function parseHousingCreationData(
  formData: FormData,
  type: CreateManualAssetInput["type"],
  today: string,
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

  const acquisition = parseIsoDateField(date, {
    invalidMessage: "La fecha de adquisición no es válida.",
    rejectFuture: true,
    today,
    futureMessage: "La fecha de adquisición no puede ser futura.",
  });

  if (!acquisition.ok) {
    return { ok: false, error: acquisition.error };
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

  const validated = parseIsoDateField(valuationDate, {
    invalidMessage: "La fecha de la tasación inicial no es válida.",
    rejectFuture: true,
    today,
    futureMessage: "La fecha de la tasación inicial no puede ser futura.",
  });

  if (!validated.ok) {
    return { ok: false, error: validated.error };
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

  const validated = parseIsoDateField(valuationDate, {
    invalidMessage: "La fecha de la tasación no es válida.",
    rejectFuture: true,
    today,
    futureMessage: "La fecha no puede ser futura.",
  });

  if (!validated.ok) {
    return { ok: false, error: validated.error };
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

  // Percent → clean decimal string ("0.025", "0.03") lives in the shared
  // primitive; here we only own the field-specific null/negative messages.
  return { ok: true, rate: parsePercentToDecimal(raw)! };
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

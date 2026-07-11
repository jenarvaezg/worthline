/**
 * Single-date snapshot unit-price correction (#926, ADR 0033 complement).
 *
 * The monthly backfill only touches month-start dates; this plan validates one
 * arbitrary YYYY-MM-DD where the position existed and emits the point the apply
 * seam would write (create vs update). Pure — writes nothing.
 */

import type { DecimalString } from "./decimal";
import { compareUnits, multiplyToMinor } from "./decimal";
import type { InvestmentOperation } from "./investment-types";
import { parseDecimalStrict } from "./money";
import { derivePosition, operationsUpTo } from "./positions";

export type SnapshotPriceCorrectionRejectReason =
  | "invalid_date"
  | "invalid_price"
  | "no_operations"
  | "no_position";

export interface PlanSnapshotPriceCorrectionInput {
  operations: readonly InvestmentOperation[];
  dateKey: string;
  unitPriceRaw: string;
  existingSnapshotDates: ReadonlySet<string>;
}

export interface SnapshotPriceCorrectionPoint {
  dateKey: string;
  unitPriceDecimal: DecimalString;
  units: DecimalString;
  valueMinor: number;
  action: "create" | "update";
}

export type PlanSnapshotPriceCorrectionResult =
  | { ok: false; reason: SnapshotPriceCorrectionRejectReason }
  | { ok: true; point: SnapshotPriceCorrectionPoint };

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function planSnapshotPriceCorrection(
  input: PlanSnapshotPriceCorrectionInput,
): PlanSnapshotPriceCorrectionResult {
  const dateKey = input.dateKey.trim();
  if (!DATE_KEY_RE.test(dateKey)) {
    return { ok: false, reason: "invalid_date" };
  }

  const unitPriceRaw = input.unitPriceRaw.trim();
  const priceNum = parseDecimalStrict(unitPriceRaw);
  if (priceNum === null || priceNum <= 0) {
    return { ok: false, reason: "invalid_price" };
  }
  const unitPriceDecimal = unitPriceRaw as DecimalString;

  if (input.operations.length === 0) {
    return { ok: false, reason: "no_operations" };
  }

  const opsUpTo = operationsUpTo(input.operations, dateKey);
  if (opsUpTo.length === 0) {
    return { ok: false, reason: "no_position" };
  }

  const assetId = input.operations[0]!.assetId;
  const currency = input.operations[0]!.currency;
  const position = derivePosition(opsUpTo, { assetId, currency });
  if (compareUnits(position.currentUnits, "0") === 0) {
    return { ok: false, reason: "no_position" };
  }

  return {
    ok: true,
    point: {
      action: input.existingSnapshotDates.has(dateKey) ? "update" : "create",
      dateKey,
      unitPriceDecimal,
      units: position.currentUnits,
      valueMinor: multiplyToMinor(position.currentUnits, unitPriceDecimal),
    },
  };
}

export function snapshotPriceCorrectionErrorMessage(
  reason: SnapshotPriceCorrectionRejectReason,
): string {
  switch (reason) {
    case "invalid_date":
      return "La fecha no es válida (usa AAAA-MM-DD).";
    case "invalid_price":
      return "El precio por unidad debe ser un número positivo.";
    case "no_operations":
      return "Esta inversión no tiene operaciones.";
    case "no_position":
      return "No había posición abierta en esa fecha.";
  }
}

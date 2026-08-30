/**
 * The position whose cost nobody ever declared (#1505).
 *
 * An alta writes a synthetic apertura. Since #1490 it asks what the position
 * cost, and an empty answer is a legitimate one — «no lo sé» is often the truth
 * about a fondo held for eleven years. What was NOT legitimate was the silence
 * afterwards: the apertura went in at today's price, the ficha printed
 * «P/L latente 0,00 €», and no surface in the app could say that the zero was an
 * absence rather than a measurement.
 *
 * Since #1505 the operation carries the grade, so this family can finally point
 * at the holding and offer the one repair that exists: type what it cost.
 */

import {
  type DataQualityCollector,
  type DataQualitySignal,
  signalLabelWithOverride,
  signalNaturalKey,
} from "./data-quality-collector";
import type { DecimalString } from "./decimal";
import type { InvestmentOperation } from "./investment-types";
import { derivePosition } from "./positions";
import { isClosedPosition } from "./warnings";
import type { ManualAsset } from "./workspace-types";

/** Machine code for a cost basis nobody declared (#1505, ADR 0048/0097). */
export const COST_BASIS_VALUE_ONLY_CODE = "COST_BASIS_VALUE_ONLY";

export interface DataQualityCostBasisInput {
  assets: readonly ManualAsset[];
  investmentOperationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>;
}

/**
 * `low`, and for the same reason the missing-ISIN signal is (#1489): nothing on
 * screen is wrong. The value is as good as any other holding's — it comes from
 * the price, not from the cost. What is missing bites only where a RETURN is read,
 * and the ficha already says so beside the figure it withholds. A `medium` here
 * would rank an unknown against a stale price that is wrong right now.
 *
 * Overrideable (ADR 0004): «no sé lo que costó» is a permanent, honest state for a
 * plan de pensiones opened in 2014, and the user must be able to say so once
 * instead of being asked forever.
 *
 * A CLOSED position is silent, exactly as everywhere else (#1348): its cost has
 * nothing left to measure.
 *
 * It files under `missing_configuration`: what is absent is a figure on the ficha,
 * and the ficha is the surface that repairs it.
 */
export const collectCostBasisSignals: DataQualityCollector<DataQualityCostBasisInput> = (
  input,
) => {
  const signals: DataQualitySignal[] = [];

  for (const asset of input.assets) {
    if (
      !input.ownedAssetIds.has(asset.id) ||
      isClosedPosition(asset, input.netUnitsByAssetId)
    ) {
      continue;
    }

    const operations = input.investmentOperationsByAssetId.get(asset.id);
    if (operations === undefined || operations.length === 0) {
      continue;
    }

    // The FOLD decides, never a scan of the rows (#1422). A user who sold the
    // whole position and bought back in still has the un-costed apertura sitting
    // in his ledger, and only `derivePosition` knows that the euros it put in the
    // pot are long gone — a row scan here would nag him about a cost that stopped
    // backing anything.
    const position = derivePosition([...operations], {
      assetId: asset.id,
      currency: asset.currency,
    });
    if (position.costBasisGrade !== "value_only") {
      continue;
    }

    const baseLabel =
      `"${asset.name}" se dio de alta sin coste de adquisición: su apertura vale lo que ` +
      "valía ese día, así que no hay plusvalía que calcular. Registra la operación con " +
      "lo que costó de verdad, o márcalo como intencional.";
    signals.push({
      affected: { id: asset.id, label: asset.name, object: "holding" },
      category: "missing_configuration",
      code: COST_BASIS_VALUE_ONLY_CODE,
      fixable: true,
      label: signalLabelWithOverride(
        baseLabel,
        COST_BASIS_VALUE_ONLY_CODE,
        asset.id,
        input.overriddenKeys,
        true,
      ),
      naturalKey: signalNaturalKey(
        "missing_configuration",
        COST_BASIS_VALUE_ONLY_CODE,
        asset.id,
      ),
      severity: "low",
    });
  }

  return signals;
};

/**
 * The positions a connected source mirrors but nothing can value (#1356).
 */

import { summarizeCoinValueGaps } from "./coin-value-gap";
import { coinValue, positionValue, type SourcePosition } from "./connected-source";
import {
  type DataQualityCollector,
  type DataQualitySignal,
  signalNaturalKey,
} from "./data-quality-collector";
import {
  type DataQualityConnectedSourceInput,
  sourceIsInScope,
} from "./data-quality-connected-source";

export interface DataQualityProjectionGapInput extends DataQualityConnectedSourceInput {
  positionsBySourceId: ReadonlyMap<string, readonly SourcePosition[]>;
}

/**
 * ONE signal per connected source, never one per position (#1356). A collection of
 * 178 coins with 77 unvalued used to push 77 identical lines into the panel and
 * bury everything actionable; the object affected was already the source, so the
 * count folds into the same natural key.
 *
 * The line says how many of how many, and — for a coin collection, whose zero has
 * several possible causes — WHAT is missing, which is the part the user can act on
 * (in Numista). An unpriced token has a single cause, so it gets no breakdown; a
 * mixed source gets none either, so a breakdown always partitions the count it
 * follows rather than explaining only part of it.
 */
export const collectProjectionGapSignals: DataQualityCollector<
  DataQualityProjectionGapInput
> = (input) => {
  const signals: DataQualitySignal[] = [];

  for (const source of input.connectedSources) {
    if (!sourceIsInScope(source, input.ownedAssetIds)) {
      continue;
    }

    const positions = input.positionsBySourceId.get(source.id) ?? [];
    const unvalued = positions.filter(isUnvaluedPosition);
    if (unvalued.length === 0) {
      continue;
    }

    const total = sumUnits(positions);
    const affectedUnits = sumUnits(unvalued);
    const { noun, lack } = unvaluedWording(positions, total);
    const coins = unvalued.filter(
      (position): position is Extract<SourcePosition, { kind: "coin" }> =>
        position.kind === "coin",
    );
    const missing =
      coins.length === unvalued.length ? summarizeCoinValueGaps(coins) : null;

    signals.push({
      affected: {
        id: source.id,
        label: source.label,
        object: "connected_source",
      },
      category: "projection_gap",
      code: "UNVALUED_POSITION",
      fixable: false,
      label:
        `${affectedUnits} de ${total} ${noun} de "${source.label}" ${lack}, a 0 € en tu patrimonio.` +
        (missing === null ? "" : ` Lo que falta: ${missing}.`),
      naturalKey: signalNaturalKey("projection_gap", "UNVALUED_POSITION", source.id),
      severity: "medium",
    });
  }

  return signals;
};

/** Whether a position contributes nothing to the figure it sits under: a coin no
 *  rung could value, or a token with no unit price. Both rules are the domain's
 *  own valuation verdict, never re-derived here (ADR 0017/0021). */
function isUnvaluedPosition(position: SourcePosition): boolean {
  return position.kind === "coin"
    ? coinValue(position).basis === "zero"
    : positionValue(position.balance, position.unitPrice).basis === "zero";
}

/** How many things a position stands for: a coin line can be `×3` (and the
 *  collection view counts coins, not lines); a token balance is always one line. */
function positionUnitCount(position: SourcePosition): number {
  return position.kind === "coin" ? position.quantity : 1;
}

function sumUnits(positions: readonly SourcePosition[]): number {
  return positions.reduce((total, position) => total + positionUnitCount(position), 0);
}

/**
 * The es-ES words a source's unvalued positions are described with. Both the noun
 * and what they lack follow the SAME kind decision, so they can never disagree
 * ("monedas … sin fuente de precio"). A source is homogeneous in practice (Numista
 * mirrors coins, Binance tokens); a mixed one falls back to the generic noun.
 */
function unvaluedWording(
  positions: readonly SourcePosition[],
  count: number,
): { noun: string; lack: string } {
  const kinds = new Set(positions.map((position) => position.kind));
  if (kinds.size !== 1) {
    return { lack: "sin valor", noun: count === 1 ? "posición" : "posiciones" };
  }
  if (kinds.has("coin")) {
    return { lack: "sin valor", noun: count === 1 ? "moneda" : "monedas" };
  }
  return { lack: "sin fuente de precio", noun: count === 1 ? "token" : "tokens" };
}

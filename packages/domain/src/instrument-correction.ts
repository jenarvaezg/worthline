/**
 * Correcting a holding's instrument AFTER the alta (#1512).
 *
 * The instrument was pickable only while adding a holding, and nowhere after: a
 * public pension filed as an `property` weighed like brick — housing rung, the
 * housing tier's guessed 3 % real return, the immobilized side of the FIRE
 * capital split, the «Vivienda» label on the ladder and a rent notice asking a
 * pension for its letting expenses. The only exit was to delete the holding and
 * re-create it, throwing away its history, its declared payouts and its ledger.
 *
 * This module owns the two questions a correction surface has to answer, and
 * nothing else — no reads, no writes, no copy:
 *
 * 1. **Which instruments may this holding become?** Not all of them. An
 *    instrument decides how the holding is VALUED (`defaultsFor(...).valuationMethod`)
 *    and, with it, which rows exist underneath: a hand-valued asset keeps its value
 *    on the asset row, a `derived` one is units × price over an operations ledger,
 *    and a connected collection mirrors positions it does not own. A correction may
 *    therefore move a holding only WITHIN its persistence shape — offering
 *    `pension_plan` to a hand-valued flat would promise a ledger that does not
 *    exist. `property` ↔ `other` is a legal correction (both keep their value on the
 *    asset row); `property` → `pension_plan` is a re-alta, and is not offered.
 * 2. **What does the correction move?** Crossing into or out of `property` moves the
 *    holding between the sellable and immobilized sides of the FIRE capital split
 *    (ADR 0078, #1447/#1460) — the one consequence big enough that the screen has to
 *    name it before saving instead of letting the user discover it afterwards.
 *
 * What this module deliberately does NOT do is re-apply the instrument's defaults.
 * `defaultsFor` suggests a rung, a valuation method and a price provider AT THE
 * ALTA; replaying them over a live holding would overwrite a declared rung or a
 * working price symbol to fix a label, which is worse than the misclassification
 * (#1512, point 4). The rung stays as declared — which is why
 * {@link instrumentCorrectionMove} takes it as an input rather than deriving it.
 *
 * Pure: vocabulary in, vocabulary out. No DB, no clock.
 */

import type { FireCapitalSideKey } from "./fire-capital-split";
import { sideOfTier } from "./fire-capital-split";
import type { Instrument } from "./instrument-catalog";
import { defaultsFor, INSTRUMENTS } from "./instrument-catalog";
import type { LiquidityTier } from "./liquidity-ladder";

/**
 * What a holding built on an instrument persists as — the frontier a correction
 * may not cross.
 *
 * - `manual`: value lives on the asset row, hand-set (`stored`) or grown by a
 *   revaluation curve (`appreciating`). Every one of these declares the legacy
 *   `AssetType` it persists under, which is what identifies the group.
 * - `investment`: `derived` from an operations ledger and a price. Declares no
 *   AssetType — it persists through the investment path.
 * - `connected`: identity and value are owned by a synced source (ADR 0016/0021),
 *   so nothing here is the user's to correct.
 * - `debt`: the owed side. Its instrument is recoverable from the pair
 *   (LiabilityType, DebtModel) — `defaultInstrumentForLiability` — so it is
 *   corrected by editing those two, never by writing an instrument column.
 */
export type InstrumentShape = "manual" | "investment" | "connected" | "debt";

/**
 * Which persistence shape an instrument builds. Total over the catalog, and read
 * off the DEFAULTS rather than off a list of names: a `derived` instrument with no
 * price provider is one whose value comes from mirrored positions instead of a
 * market quote (the coin collection today, ADR 0016), so the next connected
 * instrument lands here by construction instead of surfacing in a picker.
 */
export function instrumentShape(instrument: Instrument): InstrumentShape {
  const defaults = defaultsFor(instrument);
  if (defaults.liability) {
    return "debt";
  }
  if (defaults.assetType) {
    return "manual";
  }
  return defaults.priceProvider ? "investment" : "connected";
}

/**
 * The shape a HOLDING persists as — the row's answer, not its instrument's.
 *
 * A connected holding is `connected` whatever its instrument column says (#1691).
 * Reading the shape off the stored instrument alone let a mislabelled row
 * self-authorize: a coin collection the v14 backfill filed as `other` came out
 * `manual`, so the ficha offered to move it among the hand-valued instruments —
 * the one holding whose identity is not the user's to correct (ADR 0016/0021, ADR
 * 0102) was
 * the one holding the picker was willing to edit, and `coin_collection` was not
 * even among the offers, so the only moves on the menu were wrong ones.
 */
export function shapeOfHolding(holding: {
  instrument: Instrument;
  connectedSourceId?: string | null;
}): InstrumentShape {
  if (holding.connectedSourceId != null) {
    return "connected";
  }
  return instrumentShape(holding.instrument);
}

/** The shapes a holding can be corrected within. The other two offer no surface. */
const CORRECTABLE_SHAPES: readonly InstrumentShape[] = ["manual", "investment"];

/**
 * The instruments a holding currently on `current` may be corrected to, in the
 * order a picker should offer them — its own shape only, `current` included so the
 * select can render the holding's own value, and the `other` catch-all last.
 *
 * Derived from {@link instrumentShape} rather than hand-listed, so a new member of
 * the instrument union shows up in the picker by construction instead of going
 * missing until someone notices.
 */
export function assignableInstruments(current: Instrument): readonly Instrument[] {
  return assignableInstrumentsForShape(instrumentShape(current));
}

/**
 * The same list, keyed by the shape instead of by a holding — for a boundary that
 * knows which shape it serves but cannot read the row (the investment ficha's own
 * parser). Both gates go through here, so neither can grow its own rule.
 */
export function assignableInstrumentsForShape(
  shape: InstrumentShape,
): readonly Instrument[] {
  if (!CORRECTABLE_SHAPES.includes(shape)) {
    return [];
  }
  return INSTRUMENTS.filter((candidate) => instrumentShape(candidate) === shape).sort(
    (a, b) => Number(a === "other") - Number(b === "other"),
  );
}

/** Whether `next` is a correction the holding on `current` may actually take. */
export function isAssignableInstrument(current: Instrument, next: Instrument): boolean {
  return assignableInstruments(current).includes(next);
}

/**
 * The same list for a holding whose row is in hand — the form that knows about the
 * connected source (#1691). Prefer it over {@link assignableInstruments} wherever
 * the caller holds the asset: a connected holding offers nothing, whatever its
 * instrument column happens to say.
 */
export function assignableInstrumentsForHolding(holding: {
  instrument: Instrument;
  connectedSourceId?: string | null;
}): readonly Instrument[] {
  return assignableInstrumentsForShape(shapeOfHolding(holding));
}

/** Whether `next` is a correction THIS holding may take (see above). */
export function isAssignableInstrumentForHolding(
  holding: { instrument: Instrument; connectedSourceId?: string | null },
  next: Instrument,
): boolean {
  return assignableInstrumentsForHolding(holding).includes(next);
}

/** Whether `next` is a correction a holding of this shape may take. */
export function isAssignableInstrumentForShape(
  shape: InstrumentShape,
  next: Instrument,
): boolean {
  return assignableInstrumentsForShape(shape).includes(next);
}

/**
 * Whether a holding on this instrument may keep a known-partial ownership split —
 * true for `property` alone, mirroring the `type === "real_estate"` gate the alta
 * and the edit form already use (#171/#241).
 *
 * It matters here because the split is NOT re-asked on a correction: the edit form
 * completes a shortfall to full ownership for every other shape, so correcting a
 * 75 %-owned flat into an `other` would quietly hand the user the missing 25 % —
 * a change of net worth dressed up as a change of label. The correction seam
 * refuses that instead.
 */
export function keepsKnownPartialOwnership(instrument: Instrument): boolean {
  return defaultsFor(instrument).assetType === "real_estate";
}

/**
 * The ownership shortfall a correction would silently close, in bps — 0 when there
 * is none. `enteredBps` is the split AS TYPED (never the completed one): the save
 * completes a shortfall to full ownership for every instrument but `property`, so
 * a correction leaving it would hand the user the missing share of the value. That
 * is a change of net worth dressed as a change of label, and this is the number the
 * refusal names.
 */
export function ownershipShortfallOnCorrection(input: {
  to: Instrument;
  enteredBps: number;
}): number {
  if (keepsKnownPartialOwnership(input.to) || input.enteredBps >= FULL_OWNERSHIP_BPS) {
    return 0;
  }
  return FULL_OWNERSHIP_BPS - input.enteredBps;
}

/** A holding owned outright, in basis points. */
const FULL_OWNERSHIP_BPS = 10_000;

/**
 * What an instrument correction moves. Module-internal on purpose: the surface a
 * caller wants is {@link instrumentPickerImpact}, which answers the same question
 * about a whole picker rather than about one pair.
 */
export interface InstrumentCorrectionMove {
  from: Instrument;
  to: Instrument;
  /** The rung the holding sits on today — `housing` for a property (`tierOfAsset`). */
  fromTier: LiquidityTier;
  /** The rung it would sit on after the correction, with the declared rung unchanged. */
  toTier: LiquidityTier;
  fromSide: FireCapitalSideKey;
  toSide: FireCapitalSideKey;
  /**
   * True when the correction crosses the sellable ↔ immobilized frontier of the
   * FIRE capital split (ADR 0078). The consequence the form has to name.
   */
  movesFireCapitalSide: boolean;
}

/**
 * What correcting `from` → `to` would move for a holding whose DECLARED rung is
 * `liquidityTier`.
 *
 * The rung is an input, not a derivation, precisely because the correction does not
 * re-apply `defaultsFor(to).rung`: the user's declared availability survives, and
 * only `property`'s override of it (`tierOfAsset` → `housing`) comes or goes.
 */
export function instrumentCorrectionMove(input: {
  from: Instrument;
  to: Instrument;
  /** The rung declared on the holding, as stored — NOT the instrument's default. */
  liquidityTier: LiquidityTier;
}): InstrumentCorrectionMove {
  const { from, liquidityTier, to } = input;
  const fromTier = effectiveTier(from, liquidityTier);
  const toTier = effectiveTier(to, liquidityTier);
  const fromSide = sideOfTier(fromTier);
  const toSide = sideOfTier(toTier);

  return {
    from,
    fromSide,
    fromTier,
    movesFireCapitalSide: fromSide !== toSide,
    to,
    toSide,
    toTier,
  };
}

/** What the correction picker has to say about the holding in front of it. */
export interface InstrumentPickerImpact {
  /** Which side of the FIRE capital split the holding sits on TODAY. */
  currentSide: FireCapitalSideKey;
  /**
   * The offered instruments that would move it to the OTHER side, in the picker's
   * own order. Empty when every offer keeps it where it is — which is what a
   * holding on a rung that `property` does not override looks like.
   */
  crossing: readonly Instrument[];
}

/**
 * What the picker in front of this holding would move, so the surface states the
 * consequence instead of re-deriving it in copy. Reads the DECLARED rung, so the
 * answer is about this holding and not about the instrument in the abstract: a
 * flat corrected to `other` crosses the frontier only when its declared
 * availability is a sellable rung.
 */
export function instrumentPickerImpact(input: {
  current: Instrument;
  liquidityTier: LiquidityTier;
}): InstrumentPickerImpact {
  const { current, liquidityTier } = input;
  const moves = assignableInstruments(current).map((candidate) =>
    instrumentCorrectionMove({ from: current, liquidityTier, to: candidate }),
  );
  return {
    crossing: moves.filter((move) => move.movesFireCapitalSide).map((move) => move.to),
    // Every move starts from the same holding, so any of them answers this; the
    // no-op correction of `current` onto itself is always among them.
    currentSide: sideOfTier(effectiveTier(current, liquidityTier)),
  };
}

/**
 * The rung a holding on this instrument actually lands on — `tierOfAsset`'s rule,
 * spelled over the vocabulary instead of over an asset row so the picker can ask it
 * about an instrument the holding does not have yet.
 */
function effectiveTier(instrument: Instrument, declared: LiquidityTier): LiquidityTier {
  return instrument === "property" ? "housing" : declared;
}

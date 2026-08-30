/**
 * The board's projection: from the domain's grouped units to the subsections and
 * composition segments one pane paints (#271, #154, #1608).
 *
 * Pure — no React, no `window` — so the shape of a pane can be reasoned about
 * (and tested) without rendering one, the same split `optimistic-board` and
 * `board-fold` already make for the merge and the fold.
 */

import { barColor, magnitude } from "@web/patrimonio/_board/board-format";
import type { BoardUnit, PortfolioGroup, UnifiedHolding } from "@worthline/domain";

/** One labelled subsection of a pane: the grouping axis (#154) made visible. */
export interface Section {
  key: string;
  label: string;
  tier: UnifiedHolding["tier"];
  /** The section's summands: loose rows and whole managed portfolios (#1548). */
  units: BoardUnit[];
}

/**
 * A fully-sold position: a derived (units × price) asset reading exactly 0
 * WITH recorded operations. The domain already blesses the derived 0 as
 * "correct, not an anomaly" (the ZERO_VALUE_ASSET warning exempts derived
 * holdings), and a derived 0 can ONLY mean no units — a priceless position
 * falls back to its cost basis, never to 0. A statement import with a real
 * sell history leaves dozens of these; they stay fully functional (ficha,
 * returns, history) behind the fold instead of burying the live portfolio.
 *
 * The operated-set guard is what separates "sold out" from "just created": a
 * brand-new investment also reads 0 until its first buy, and folding it away
 * the moment the user adds it would make it look lost. A manual/stored asset
 * at 0 stays in the list either way: for those, 0 IS the anomaly its warning
 * points at.
 */
export function isClosedPosition(
  h: UnifiedHolding,
  operatedIds: ReadonlySet<string>,
): boolean {
  return (
    h.direction === "asset" &&
    h.valueIsDerived &&
    h.valueMinor === 0 &&
    operatedIds.has(h.id)
  );
}

/** A summand's magnitude — a block's is the sum of its members. */
export function unitMagnitude(unit: BoardUnit): number {
  return unit.kind === "portfolio" ? unit.signedMinor : magnitude(unit.holding);
}

/** The rung a summand paints in — a block's is its dominant one. */
export function unitTier(unit: BoardUnit): UnifiedHolding["tier"] {
  return unit.kind === "portfolio" ? unit.tier : unit.holding.tier;
}

/** A summand's label, for composition-bar hovers. */
export function unitName(unit: BoardUnit): string {
  return unit.kind === "portfolio" ? unit.portfolio.name : unit.holding.name;
}

/**
 * One direction's holdings as labelled subsections. Sections keep the grouping-axis
 * order (ladder for Liquidez, first-seen for Instrumento); rows WITHIN a section are
 * sorted by amount, largest first. `.filter` already copies, so the sort never
 * mutates the projection.
 */
export function sectionsFor(
  groups: PortfolioGroup[],
  direction: UnifiedHolding["direction"],
): Section[] {
  return groups
    .map((g) => {
      const units = g.units
        .filter((unit) =>
          unit.kind === "portfolio"
            ? direction === "asset"
            : unit.holding.direction === direction,
        )
        .sort((a, b) => unitMagnitude(b) - unitMagnitude(a));
      const first = units[0];
      return {
        key: g.key,
        label: g.label,
        tier: first ? unitTier(first) : "cash",
        units,
      };
    })
    .filter((s) => s.units.length > 0);
}

export const sectionTotal = (units: BoardUnit[]) =>
  units.reduce((acc, unit) => acc + unitMagnitude(unit), 0);

/**
 * One pane's composition bar, as value-weighted segments: by SUBSECTION when the
 * grouping axis subdivided the pane, else by holding — a single-section pane's
 * bar would otherwise be one flat block saying nothing. `denom` never reaches 0,
 * so an empty pane divides by 1 instead of painting `NaN%`.
 */
export function paneSegments(sections: Section[], isAsset: boolean) {
  const denom = sections.reduce((acc, s) => acc + sectionTotal(s.units), 0) || 1;
  const color = (tier: UnifiedHolding["tier"]) => barColor(tier, isAsset);
  const segments =
    sections.length > 1
      ? sections.map((s) => ({
          key: s.key,
          value: sectionTotal(s.units),
          color: color(s.tier),
          label: s.label,
        }))
      : (sections[0]?.units ?? []).map((unit) => ({
          key: unit.key,
          value: unitMagnitude(unit),
          color: color(unitTier(unit)),
          label: unitName(unit),
        }));
  return { denom, segments };
}

import { chipChoicesMarkedFirst } from "@web/chip-choice-view";
import type { ManualAsset } from "@worthline/domain";

/**
 * The chip selector of the canon (`docs/design-system.md` §4) — the ONE place
 * that renders `.chipChoice` markup.
 *
 * Two things a hand-rolled copy kept getting wrong (#1483): the marked chip was
 * only a tint, unreadable on a lit phone next to an unmarked one, and the marked
 * chips sat wherever the catalogue put them. Both live here now, so a new
 * selector cannot be born without them.
 */
export function ChipChoice({
  name,
  options,
  selectedIds,
}: {
  /** Form field every chip posts under. */
  name: string;
  options: readonly ManualAsset[];
  selectedIds: readonly string[];
}) {
  return (
    <span className="chipChoice">
      {chipChoicesMarkedFirst({ options, selectedIds }).map(({ asset, checked }) => (
        <label key={asset.id}>
          <input defaultChecked={checked} name={name} type="checkbox" value={asset.id} />
          {/* The box; its ✓ is drawn by the canon only while the input is checked,
              so the mark cannot go stale when the browser toggles the chip. The
              native checkbox already announces the state to a screen reader. */}
          <span aria-hidden="true" className="chipMark" />
          {asset.name}
        </label>
      ))}
    </span>
  );
}

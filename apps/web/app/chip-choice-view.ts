import type { ManualAsset } from "@worthline/domain";

/**
 * The order of a chip selector (#1483).
 *
 * A chip selector prints every candidate, so the marked ones can end up below a
 * dozen unmarked ones — which is how two readers in a row concluded that their
 * whole portfolio was consuming the pension allowance. Marked first, then; and
 * within each group the catalogue order survives, so the list cannot dance
 * between two loads of the same screen.
 *
 * Decided once, on the server (ADR 0036): the browser only toggles checkboxes,
 * and a list that re-sorted itself under the finger would be worse than one
 * that never sorted at all.
 */

export interface ChipChoiceEntry {
  asset: ManualAsset;
  checked: boolean;
}

export function chipChoicesMarkedFirst(input: {
  options: readonly ManualAsset[];
  selectedIds: readonly string[];
}): ChipChoiceEntry[] {
  const selected = new Set(input.selectedIds);
  const entries = input.options.map((asset) => ({
    asset,
    checked: selected.has(asset.id),
  }));

  return [
    ...entries.filter((entry) => entry.checked),
    ...entries.filter((entry) => !entry.checked),
  ];
}

import type { ManualAsset } from "@worthline/domain";

/**
 * Up to this many options a selector prints them all as chips; past it, the chips
 * become a wall the reader scans instead of reads, and the selector turns into
 * the ledger with a search field and a basket (#1837).
 */
export const CHIP_CHOICE_CHIPS_MAX = 12;

export type ChipChoiceMode = "chips" | "ledger";

/** Decided by the catalogue's size alone: no consumer picks the mode (#1837). */
export function chipChoiceMode(optionCount: number): ChipChoiceMode {
  return optionCount > CHIP_CHOICE_CHIPS_MAX ? "ledger" : "chips";
}

/**
 * Text as a reader compares it: no case, no accents, no stray spaces. Shared by
 * the twin check and the ledger's search, so «telefonica» finds «Telefónica» and
 * the two also count as the same visible name.
 */
export function normalizeForSearch(text: string): string {
  return foldForSearch(text).trim();
}

/**
 * The fold itself, without the trim: what the ledger's highlight applies letter by
 * letter, so the mark lands where the search matched and never disagrees with it.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * The code that tells twins apart (#1837): when two options share a visible
 * name, each carries its ISIN or DGS code — or its symbol, when it has no
 * identifier — so «Fidelity MSCI World» acc and dist stop being a coin toss.
 * Options with a unique name, or a twin with nothing to show, get no entry.
 */
export function chipChoiceTwinCodes(
  options: readonly ManualAsset[],
): ReadonlyMap<string, string> {
  const namesakes = new Map<string, number>();
  for (const option of options) {
    const key = normalizeForSearch(option.name);
    namesakes.set(key, (namesakes.get(key) ?? 0) + 1);
  }

  const codes = new Map<string, string>();
  for (const option of options) {
    if ((namesakes.get(normalizeForSearch(option.name)) ?? 0) < 2) continue;
    const code = option.securityId?.value || option.providerSymbol;
    if (code) codes.set(option.id, code);
  }
  return codes;
}

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

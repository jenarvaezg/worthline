import {
  chipChoiceMode,
  chipChoicesMarkedFirst,
  chipChoiceTwinCodes,
} from "@web/chip-choice-view";
import { ChipLedger } from "@web/chip-ledger";
import { chipLedgerGroups } from "@web/chip-ledger-view";
import type { ManualAsset } from "@worthline/domain";

/**
 * The holding selector of the canon (`docs/design-system.md` §4) — the ONE place
 * that renders it, in either of its two modes.
 *
 * Two things a hand-rolled copy kept getting wrong (#1483): the marked chip was
 * only a tint, unreadable on a lit phone next to an unmarked one, and the marked
 * chips sat wherever the catalogue put them. Both live here now, so a new
 * selector cannot be born without them.
 *
 * And it scales on its own (#1837): up to a dozen options it prints chips; past
 * that the chips were a wall of ~80 the reader scanned instead of read, so it
 * prints the ledger — search, rungs, basket — instead. The consumer never picks.
 */
export function ChipChoice({
  name,
  options,
  privacyMode,
  selectedIds,
}: {
  /** Form field every option posts under. */
  name: string;
  options: readonly ManualAsset[];
  /** The ledger prints each option's value; the mode masks it. */
  privacyMode: boolean;
  selectedIds: readonly string[];
}) {
  if (chipChoiceMode(options.length) === "ledger") {
    return (
      <ChipLedger
        groups={chipLedgerGroups({ options, privacyMode, selectedIds })}
        name={name}
      />
    );
  }

  const twinCodes = chipChoiceTwinCodes(options);
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
          {twinCodes.has(asset.id) ? (
            <span className="chipCode">{twinCodes.get(asset.id)}</span>
          ) : null}
        </label>
      ))}
    </span>
  );
}

import {
  chipChoiceTwinCodes,
  foldForSearch,
  normalizeForSearch,
} from "@web/chip-choice-view";
import {
  formatMoneyMinorPrivacy,
  LIQUIDITY_LADDER,
  LIQUIDITY_TIER_LABELS,
  type LiquidityTier,
  type ManualAsset,
} from "@worthline/domain";

/**
 * The long mode of the holding selector (#1837): past a dozen options the chips
 * become a ledger — grouped by rung, searched, folded, with a basket of what is
 * chosen. Everything the island decides lives here, pure (ADR 0036 §7); the
 * island only wires it to the DOM.
 *
 * The order is decided once, on the server, like the chips' (#1483): the browser
 * filters and folds, but never re-sorts a list under the finger.
 */

/** One option as the ledger prints it. Plain data: it crosses to the island. */
export interface ChipLedgerRow {
  id: string;
  name: string;
  /** ISIN, DGS code or symbol — shown only when another option shares the name. */
  code: string | null;
  /** Name, identifier and symbol, normalized once for the search to read. */
  searchText: string;
  /** The native figure, privacy-masked when the mode is on. */
  valueLabel: string;
  /** Marked when the page loaded. */
  checked: boolean;
}

export interface ChipLedgerGroup {
  rung: LiquidityTier;
  label: string;
  rows: ChipLedgerRow[];
}

/**
 * The ledger's groups: the ladder's rungs in order, empty ones dropped, and
 * within each the largest value first — the five on top double as suggestions.
 * Ties keep the catalogue order. The value compared is the native figure; a
 * foreign currency is latent today and the row prints its own.
 */
export function chipLedgerGroups(input: {
  options: readonly ManualAsset[];
  privacyMode: boolean;
  selectedIds: readonly string[];
}): ChipLedgerGroup[] {
  const selected = new Set(input.selectedIds);
  const twinCodes = chipChoiceTwinCodes(input.options);

  return LIQUIDITY_LADDER.map((rung) => ({
    label: LIQUIDITY_TIER_LABELS[rung],
    rows: input.options
      .map((asset, index) => ({ asset, index }))
      .filter(({ asset }) => asset.liquidityTier === rung)
      .sort(
        (a, b) =>
          b.asset.currentValue.amountMinor - a.asset.currentValue.amountMinor ||
          a.index - b.index,
      )
      .map(({ asset }) => ({
        checked: selected.has(asset.id),
        code: twinCodes.get(asset.id) ?? null,
        id: asset.id,
        name: asset.name,
        searchText: normalizeForSearch(
          [asset.name, asset.securityId?.value, asset.providerSymbol]
            .filter(Boolean)
            .join(" "),
        ),
        valueLabel: formatMoneyMinorPrivacy(asset.currentValue, input.privacyMode),
      })),
    rung,
  })).filter((group) => group.rows.length > 0);
}

/** How many rows each group shows before «Ver N más». */
export const CHIP_LEDGER_PREVIEW = 5;

/**
 * Rungs that start folded: what rarely funds a goal or joins a cartera — a car, a
 * flat — waits behind its header instead of pushing the funds down.
 */
export const CHIP_LEDGER_FOLDED_RUNGS: ReadonlySet<LiquidityTier> = new Set([
  "illiquid",
  "housing",
]);

/** What the island remembers between renders. Sets, not arrays: order is the ledger's. */
export interface ChipLedgerState {
  query: string;
  /** Mirror of the checked boxes; the boxes themselves are what the form posts. */
  selected: ReadonlySet<string>;
  /** Rows toggled this session: they stay in sight when the window closes. */
  touched: ReadonlySet<string>;
  /** Folded rungs the reader opened by hand. */
  opened: ReadonlySet<LiquidityTier>;
  /** Rungs whose window is lifted («Ver N más»). */
  expanded: ReadonlySet<LiquidityTier>;
}

export function initialChipLedgerState(
  groups: readonly ChipLedgerGroup[],
): ChipLedgerState {
  return {
    expanded: new Set(),
    opened: new Set(),
    query: "",
    selected: new Set(
      groups
        .flatMap((group) => group.rows.filter((row) => row.checked))
        .map((row) => row.id),
    ),
    touched: new Set(),
  };
}

export type ChipLedgerAction =
  | { type: "search"; query: string }
  /** A box changed: the DOM already holds `checked`, the mirror follows. */
  | { type: "toggle"; id: string; checked: boolean }
  /**
   * Enter added the flagged row: mark it and clear the search. Its rung stays
   * open, or clearing the search would fold away what was just added.
   */
  | { type: "add"; id: string; rung: LiquidityTier }
  | { type: "fold"; rung: LiquidityTier }
  | { type: "window"; rung: LiquidityTier }
  /** On hydration: the boxes the browser holds checked, in document order. */
  | { type: "sync"; checkedIds: readonly string[] };

function flip<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(item)) next.add(item);
  return next;
}

function withMark(
  selected: ReadonlySet<string>,
  id: string,
  checked: boolean,
): ReadonlySet<string> {
  const next = new Set(selected);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

export function chipLedgerReducer(
  state: ChipLedgerState,
  action: ChipLedgerAction,
): ChipLedgerState {
  switch (action.type) {
    case "search":
      return { ...state, query: action.query };
    case "toggle":
      return {
        ...state,
        selected: withMark(state.selected, action.id, action.checked),
        touched: new Set(state.touched).add(action.id),
      };
    case "add":
      return {
        ...state,
        opened: new Set(state.opened).add(action.rung),
        query: "",
        selected: withMark(state.selected, action.id, true),
        touched: new Set(state.touched).add(action.id),
      };
    case "fold":
      return { ...state, opened: flip(state.opened, action.rung) };
    case "window":
      return { ...state, expanded: flip(state.expanded, action.rung) };
    case "sync": {
      const checked = new Set(action.checkedIds);
      // A box the browser flipped is a row the reader touched, if not this session:
      // it must not hide behind «Ver N más» while the basket lists it.
      const flipped = [
        ...action.checkedIds.filter((id) => !state.selected.has(id)),
        ...[...state.selected].filter((id) => !checked.has(id)),
      ];
      if (flipped.length === 0) return state;
      return {
        ...state,
        selected: checked,
        touched: new Set([...state.touched, ...flipped]),
      };
    }
  }
}

/**
 * What the basket lists: the chosen rows in the order they were chosen — those
 * marked on load first, in ledger order, then each new one at the end, so the
 * basket only ever grows at its foot while the reader works.
 */
export function chipLedgerBasket(
  groups: readonly ChipLedgerGroup[],
  state: ChipLedgerState,
): ChipLedgerRow[] {
  const byId = new Map(groups.flatMap((group) => group.rows).map((row) => [row.id, row]));
  return [...state.selected].flatMap((id) => byId.get(id) ?? []);
}

export interface ChipLedgerRowView {
  row: ChipLedgerRow;
  /** False hides the row; it is never dropped, so its box keeps posting. */
  visible: boolean;
  /** The row Enter would add: flagged, not chosen. */
  target: boolean;
}

/** The window's text control: «Ver N más de Mercado» or back to the largest. */
export type ChipLedgerMore =
  | { kind: "more"; count: number; label: string }
  | { kind: "less"; label: string }
  | null;

export interface ChipLedgerGroupView extends Omit<ChipLedgerGroup, "rows"> {
  rows: ChipLedgerRowView[];
  more: ChipLedgerMore;
  /** How many of its rows are chosen right now («N elegidos»). */
  chosenCount: number;
  /** The header's count: «N», or «m de N» while searching. */
  count: string;
  /** The header folds and unfolds the group. */
  foldable: boolean;
  open: boolean;
  /** False while a search finds nothing in the group: the whole group steps aside. */
  shown: boolean;
}

export interface ChipLedgerView {
  groups: ChipLedgerGroupView[];
  searching: boolean;
  /** Rows matching the search, across groups. */
  matchCount: number;
  /**
   * What Enter adds: the first unchosen match in ledger order, when searching —
   * with its rung, which Enter keeps open.
   */
  target: { row: ChipLedgerRow; rung: LiquidityTier } | null;
}

/** How a row is named aloud and in the hint: a twin carries its code. */
export function chipLedgerRowLabel(row: ChipLedgerRow): string {
  return row.code ? `${row.name} (${row.code})` : row.name;
}

export function chipLedgerRowMatches(row: ChipLedgerRow, query: string): boolean {
  return row.searchText.includes(normalizeForSearch(query));
}

/**
 * What the ledger shows for a state. Every row of every group is in the result —
 * hidden, never dropped — because a box the reader cannot see still posts.
 *
 * At rest each group shows its {@link CHIP_LEDGER_PREVIEW} largest; a row marked
 * on load or touched this session stays in sight beyond them, so the list does
 * not move under the finger — not even to hide what was just unmarked. While
 * searching there is no window and no fold: every match shows, and a group with
 * none steps aside.
 */
export function chipLedgerView(
  groups: readonly ChipLedgerGroup[],
  state: ChipLedgerState,
): ChipLedgerView {
  const searching = normalizeForSearch(state.query) !== "";
  const target = searching
    ? (groups
        .flatMap((group) => group.rows.map((row) => ({ row, rung: group.rung })))
        .find(
          ({ row }) =>
            chipLedgerRowMatches(row, state.query) && !state.selected.has(row.id),
        ) ?? null)
    : null;

  const views = groups.map((group): ChipLedgerGroupView => {
    const expanded = state.expanded.has(group.rung);
    const folded = CHIP_LEDGER_FOLDED_RUNGS.has(group.rung);
    const rows = group.rows.map((row, index) => ({
      row,
      target: row.id === target?.row.id,
      visible: searching
        ? chipLedgerRowMatches(row, state.query)
        : expanded ||
          index < CHIP_LEDGER_PREVIEW ||
          row.checked ||
          state.touched.has(row.id),
    }));
    const visibleCount = rows.filter((entry) => entry.visible).length;
    const hiddenCount = rows.length - visibleCount;
    const more: ChipLedgerMore =
      searching || rows.length <= CHIP_LEDGER_PREVIEW
        ? null
        : expanded
          ? { kind: "less", label: `Ver solo los ${CHIP_LEDGER_PREVIEW} mayores` }
          : hiddenCount > 0
            ? {
                count: hiddenCount,
                kind: "more",
                label: `Ver ${hiddenCount} más de ${group.label}`,
              }
            : null;

    return {
      chosenCount: group.rows.filter((row) => state.selected.has(row.id)).length,
      count: searching ? `${visibleCount} de ${rows.length}` : String(rows.length),
      foldable: folded && !searching,
      label: group.label,
      more,
      open: searching || !folded || state.opened.has(group.rung),
      rows,
      rung: group.rung,
      shown: !searching || visibleCount > 0,
    };
  });

  return {
    groups: views,
    matchCount: searching
      ? views.reduce(
          (sum, group) => sum + group.rows.filter((entry) => entry.visible).length,
          0,
        )
      : 0,
    searching,
    target,
  };
}

export interface ChipLedgerSegment {
  text: string;
  hit: boolean;
}

/**
 * A name cut around the first match of the search, for the row to mark it. The
 * match ignores case and accents, like the search; the segments keep the name as
 * it reads, accents included. A match found only in the identifier leaves the
 * name whole.
 */
export function chipLedgerHighlight(text: string, query: string): ChipLedgerSegment[] {
  // NFC first: an accent typed apart from its letter («o» + U+0301) then travels
  // with it, so the cut can never land between the two.
  const display = text.normalize("NFC");
  const needle = normalizeForSearch(query);
  if (needle === "") return [{ hit: false, text: display }];

  // The normalized name, and for each of its code units the span of `display` it
  // came from — the way back from a match to what the reader sees.
  let folded = "";
  const spans: { start: number; end: number }[] = [];
  let offset = 0;
  for (const char of display) {
    const piece = foldForSearch(char);
    for (let unit = 0; unit < piece.length; unit += 1) {
      spans.push({ end: offset + char.length, start: offset });
    }
    folded += piece;
    offset += char.length;
  }

  const at = folded.indexOf(needle);
  if (at < 0) return [{ hit: false, text: display }];
  const start = spans[at]!.start;
  const end = spans[at + needle.length - 1]!.end;

  return [
    { hit: false, text: display.slice(0, start) },
    { hit: true, text: display.slice(start, end) },
    { hit: false, text: display.slice(end) },
  ].filter((segment) => segment.text !== "");
}

/**
 * The line under the search field. While a search has an unchosen match it names
 * what Enter would add — with the twin's code, so the reader knows WHICH Fidelity
 * — and the island prints `label` in bold after an «Enter» key cap.
 */
export type ChipLedgerHint =
  | { kind: "enter"; label: string; tail: string }
  | { kind: "text"; text: string };

export function chipLedgerHint(view: ChipLedgerView): ChipLedgerHint {
  if (!view.searching) {
    const total = view.groups.reduce((sum, group) => sum + group.rows.length, 0);
    return {
      kind: "text",
      text: `${total} ${total === 1 ? "activo" : "activos"} · los mayores de cada grupo primero`,
    };
  }
  if (view.target) {
    return {
      kind: "enter",
      label: chipLedgerRowLabel(view.target.row),
      tail: view.matchCount > 1 ? ` · ${view.matchCount} coincidencias` : "",
    };
  }
  if (view.matchCount === 0) return { kind: "text", text: "Ninguna coincidencia" };
  return {
    kind: "text",
    text:
      view.matchCount === 1
        ? "1 coincidencia, ya elegida"
        : `${view.matchCount} coincidencias, todas elegidas`,
  };
}

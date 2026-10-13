"use client";

import {
  type ChipLedgerGroup,
  type ChipLedgerRow,
  chipLedgerBasket,
  chipLedgerHighlight,
  chipLedgerHint,
  chipLedgerReducer,
  chipLedgerRowLabel,
  chipLedgerView,
  initialChipLedgerState,
} from "@web/chip-ledger-view";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";

/**
 * The long mode of the holding selector (#1837, `docs/design-system.md` §4):
 * search first, the ledger by rung, the chosen ones as a basket. Only
 * `chip-choice.tsx` mounts it — consumers never pick the mode.
 *
 * The ledger's boxes are the ONLY thing the form posts, and they are native and
 * uncontrolled (`defaultChecked`): the server prints every one of them, so the
 * form posts the same before hydration as after. A row hidden by the search or
 * by the window stays mounted and keeps posting. The basket is a mirror with no
 * inputs; its × unticks the box in the ledger.
 *
 * Every decision lives in `chip-ledger-view.ts`; this file only wires it to the
 * DOM (ADR 0036 §7).
 */
export function ChipLedger({
  groups,
  name,
}: {
  groups: ChipLedgerGroup[];
  /** Form field every box posts under. */
  name: string;
}) {
  const [state, dispatch] = useReducer(chipLedgerReducer, groups, initialChipLedgerState);
  const [announcement, setAnnouncement] = useState("");
  const bookRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const hintId = `${baseId}-hint`;

  const view = chipLedgerView(groups, state);
  const hint = chipLedgerHint(view);
  const basket = chipLedgerBasket(groups, state);

  // The boxes are the truth: a tick landed before hydration, a form the browser
  // restored on «back», or the reset React runs after a successful action must
  // all show in the basket exactly as the form will post.
  useEffect(() => {
    const book = bookRef.current;
    if (!book) return;
    const sync = () =>
      dispatch({
        checkedIds: boxesIn(book)
          .filter((box) => box.checked)
          .map((box) => box.value),
        type: "sync",
      });
    sync();
    // `reset` fires BEFORE the boxes go back to their defaults: read them after.
    const form = book.closest("form");
    const afterReset = () => setTimeout(sync, 0);
    form?.addEventListener("reset", afterReset);
    return () => form?.removeEventListener("reset", afterReset);
  }, []);

  function boxFor(id: string): HTMLInputElement | null {
    return boxesIn(bookRef.current).find((box) => box.value === id) ?? null;
  }

  function announce(row: ChipLedgerRow, checked: boolean) {
    setAnnouncement(`${checked ? "Añadido" : "Quitado"}: ${chipLedgerRowLabel(row)}`);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      // Enter never submits the form: it adds the flagged row, if there is one.
      event.preventDefault();
      const target = view.target;
      const box = target ? boxFor(target.row.id) : null;
      if (!target || !box) return;
      box.checked = true;
      dispatch({ id: target.row.id, rung: target.rung, type: "add" });
      announce(target.row, true);
    } else if (event.key === "Escape" && view.searching) {
      event.preventDefault();
      dispatch({ query: "", type: "search" });
    } else if (event.key === "ArrowDown") {
      const first = boxesIn(bookRef.current).find((box) => box.offsetParent !== null);
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function removeFromBasket(row: ChipLedgerRow, button: HTMLButtonElement) {
    const box = boxFor(row.id);
    if (box) box.checked = false;
    // The × the reader pressed is about to go: hand the focus to the next one,
    // or back to the search when the basket empties.
    const buttons = [
      ...(button.closest("ul")?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    const at = buttons.indexOf(button);
    const next = buttons[at + 1] ?? buttons[at - 1];
    (next ?? searchRef.current)?.focus();
    dispatch({ checked: false, id: row.id, type: "toggle" });
    announce(row, false);
  }

  return (
    <div className="chipLedger">
      <div className="chipLedgerLayout">
        <aside aria-label="Elegidos" className="chipLedgerBasket">
          {/* The header only shows on a wide screen: on a phone the chips sit
              right under the question, and another uppercase would be noise. */}
          <div className="chipLedgerHead chipLedgerBasketHead">
            <span>Elegidos</span>
            <span className="chipLedgerCount">{basket.length}</span>
          </div>
          {basket.length > 0 ? (
            <ul className="chipLedgerBasketList">
              {basket.map((row) => (
                <li className="chipLedgerBasketItem" key={row.id}>
                  <span className="chipLedgerBasketName">{row.name}</span>
                  {row.code ? <span className="chipLedgerCode">{row.code}</span> : null}
                  <span className="chipLedgerBasketValue">{row.valueLabel}</span>
                  <button
                    aria-label={`Quitar ${chipLedgerRowLabel(row)}`}
                    className="chipLedgerRemove"
                    onClick={(event) => removeFromBasket(row, event.currentTarget)}
                    type="button"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="chipLedgerEmpty">
              Aún no has elegido ninguno. Búscalo o márcalo en la lista.
            </p>
          )}
        </aside>

        <div className="chipLedgerSearchBar">
          <input
            aria-describedby={hintId}
            aria-label="Buscar un activo"
            className="chipLedgerSearch"
            onChange={(event) => dispatch({ query: event.target.value, type: "search" })}
            onKeyDown={onSearchKey}
            placeholder="Busca por nombre o ISIN"
            ref={searchRef}
            type="search"
            value={state.query}
          />
          <p className="chipLedgerHint" id={hintId}>
            {hint.kind === "enter" ? (
              <>
                <kbd>Enter</kbd> añade <strong>{hint.label}</strong>
                {hint.tail}
              </>
            ) : (
              hint.text
            )}
          </p>
        </div>

        <div className="chipLedgerBook" ref={bookRef}>
          {view.groups.map((group) => {
            const rowsId = `${baseId}-${group.rung}`;
            const meta = (
              <span className="chipLedgerGroupMeta">
                {group.chosenCount > 0 ? (
                  <span className="chipLedgerGroupChosen">
                    {group.chosenCount} {group.chosenCount === 1 ? "elegido" : "elegidos"}
                  </span>
                ) : null}
                <span className="chipLedgerCount">{group.count}</span>
              </span>
            );
            return (
              <section
                aria-label={group.label}
                className="chipLedgerGroup"
                hidden={!group.shown}
                key={group.rung}
              >
                {group.foldable ? (
                  <button
                    aria-controls={rowsId}
                    aria-expanded={group.open}
                    className="chipLedgerHead chipLedgerGroupHead chipLedgerFold"
                    onClick={() => dispatch({ rung: group.rung, type: "fold" })}
                    type="button"
                  >
                    <span>
                      <span aria-hidden="true" className="chipLedgerCaret">
                        {group.open ? "▾" : "▸"}
                      </span>
                      {group.label}
                    </span>
                    {meta}
                  </button>
                ) : (
                  <div className="chipLedgerHead chipLedgerGroupHead">
                    <span>{group.label}</span>
                    {meta}
                  </div>
                )}
                <div className="chipLedgerRows" hidden={!group.open} id={rowsId}>
                  {group.rows.map(({ row, target, visible }) => (
                    <label
                      className="chipLedgerRow"
                      data-target={target || undefined}
                      hidden={!visible}
                      key={row.id}
                    >
                      <input
                        defaultChecked={row.checked}
                        name={name}
                        onChange={(event) => {
                          dispatch({
                            checked: event.target.checked,
                            id: row.id,
                            type: "toggle",
                          });
                          announce(row, event.target.checked);
                        }}
                        type="checkbox"
                        value={row.id}
                      />
                      <span className="chipLedgerName">
                        <Highlighted query={state.query} text={row.name} />
                        {row.code ? (
                          <span className="chipLedgerCode">
                            <Highlighted query={state.query} text={row.code} />
                          </span>
                        ) : null}
                      </span>
                      <span className="chipLedgerValue">{row.valueLabel}</span>
                    </label>
                  ))}
                  {group.more ? (
                    <button
                      className="chipLedgerMore"
                      onClick={() => dispatch({ rung: group.rung, type: "window" })}
                      type="button"
                    >
                      {group.more.label}
                    </button>
                  ) : null}
                </div>
              </section>
            );
          })}
          {view.searching && view.matchCount === 0 ? (
            <p className="chipLedgerNoMatch">
              Ningún activo coincide con «{state.query.trim()}».{" "}
              <button
                className="chipLedgerMore"
                onClick={() => {
                  dispatch({ query: "", type: "search" });
                  searchRef.current?.focus();
                }}
                type="button"
              >
                Borrar la búsqueda
              </button>
            </p>
          ) : null}
        </div>
      </div>

      <p aria-live="polite" className="srOnly">
        {announcement}
      </p>
    </div>
  );
}

/** Text with the search's match marked; the mark follows the search's own fold. */
function Highlighted({ query, text }: { query: string; text: string }) {
  return chipLedgerHighlight(text, query).map((segment) =>
    segment.hit ? (
      // One match at most per text: the key never repeats.
      <mark className="chipLedgerHit" key="hit">
        {segment.text}
      </mark>
    ) : (
      segment.text
    ),
  );
}

/** The ledger's boxes — the form's truth — in document order. */
function boxesIn(book: HTMLElement | null): HTMLInputElement[] {
  return [...(book?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? [])];
}

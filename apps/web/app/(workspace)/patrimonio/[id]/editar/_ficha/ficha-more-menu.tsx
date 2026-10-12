"use client";

import type { FichaAction } from "@web/patrimonio/[id]/editar/_families/family-contract";
import { useEffect, useRef, useState } from "react";

/**
 * The actions that are not done every week, behind «Más». A disclosure, not an
 * ARIA menu: a list of buttons that opens and closes, with no arrow-key contract to
 * half-honour. It closes on a choice, on Esc and on a click outside it.
 */
export function FichaMoreMenu({
  active,
  items,
  onOpen,
}: {
  /** One of its actions is the one on show — the toggle says so. */
  active: boolean;
  items: readonly FichaAction[];
  onOpen: (key: string, trigger: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    // Capture, so it runs before the panel's own Esc and can claim the key.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div className="fichaMore" ref={rootRef}>
      <button
        aria-expanded={open}
        className={active ? "btn btnSecondary fichaMoreActive" : "btn btnSecondary"}
        data-ficha-more=""
        onClick={() => setOpen((isOpen) => !isOpen)}
        ref={toggleRef}
        type="button"
      >
        Más <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul className="fichaMoreList">
          {items.map((item) => (
            <li key={item.key}>
              <button
                className="fichaMoreItem"
                onClick={() => {
                  setOpen(false);
                  // The item leaves with the list; focus comes back to the toggle.
                  onOpen(item.key, toggleRef.current);
                }}
                type="button"
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

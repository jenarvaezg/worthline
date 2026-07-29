"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

const KEY = "worthline:form-submit-scroll";

interface SavedScroll {
  pathname: string;
  x: number;
  y: number;
}

function readSavedScroll(): SavedScroll | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedScroll>;
    return typeof saved.pathname === "string" &&
      typeof saved.x === "number" &&
      typeof saved.y === "number"
      ? { pathname: saved.pathname, x: saved.x, y: saved.y }
      : null;
  } catch {
    return null;
  }
}

function saveScroll(scroll: SavedScroll) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(scroll));
  } catch {
    // Scroll restoration is best-effort.
  }
}

function removeSavedScroll() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Scroll restoration is best-effort.
  }
}

export default function FormSubmitScrollKeeper() {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    const onSubmit = (event: SubmitEvent) => {
      if (!(event.target instanceof HTMLFormElement)) return;
      if (event.target.method.toLowerCase() === "dialog") return;
      if (window.scrollX === 0 && window.scrollY === 0) return;

      saveScroll({
        pathname: window.location.pathname,
        x: window.scrollX,
        y: window.scrollY,
      });
    };

    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);

  // `search` is a deliberate re-run trigger, not a value the effect reads (#1275).
  // Mutations routinely land back on the SAME pathname with a different query
  // (?ok=…, filters, ?anchor=…); with only `pathname` in the list the effect would
  // not re-run and the saved scroll would never be restored — the whole point of
  // this island. Biome's fix is tagged unsafe (so `check --write` leaves it
  // alone), but applying it by hand would delete that behaviour.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `search` is an intentional re-run trigger (see the comment above); dropping it breaks scroll restoration on same-pathname, query-only navigations.
  useEffect(() => {
    const saved = readSavedScroll();
    removeSavedScroll();
    if (!saved || saved.pathname !== pathname) return;

    requestAnimationFrame(() => window.scrollTo(saved.x, saved.y));
  }, [pathname, search]);

  return null;
}

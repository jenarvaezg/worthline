"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

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

  useEffect(() => {
    const saved = readSavedScroll();
    removeSavedScroll();
    if (!saved || saved.pathname !== pathname) return;

    requestAnimationFrame(() => window.scrollTo(saved.x, saved.y));
  }, [pathname, search]);

  return null;
}

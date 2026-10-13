"use client";

/**
 * NavStrip (#1723) — the scrolling strip of the topnav (`.topbarEnd`), with an
 * edge that fades while it hides something. Thin client wiring over the pure
 * `nav-strip-edges` module — the same composition as
 * `form-submit-scroll-keeper.tsx` over `form-submit-scroll.ts`.
 *
 * The verdict goes straight onto the node as `data-more`, through the ref and
 * without React state: scrolling never re-renders the strip, and the server HTML
 * (no attribute) is what the first client render produces, so hydration matches.
 * It deliberately does not read `usePathname()`, which would blank the
 * synchronous frame of the workspace layout until hydrate.
 */

import { type ReactNode, useEffect, useRef } from "react";

import { stripOverflow } from "./nav-strip-edges";

export default function NavStrip({ children }: Readonly<{ children: ReactNode }>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;

    const update = () => {
      const more = stripOverflow({
        scrollLeft: strip.scrollLeft,
        scrollWidth: strip.scrollWidth,
        clientWidth: strip.clientWidth,
      });
      if (more === "none") strip.removeAttribute("data-more");
      else strip.setAttribute("data-more", more);
    };

    // The strip's own box changes with the viewport; the nav's changes when the
    // fonts land or the fallback is swapped for the live tabs.
    const resize = new ResizeObserver(update);
    const observeBoxes = () => {
      resize.disconnect();
      resize.observe(strip);
      const nav = strip.querySelector("nav");
      if (nav) resize.observe(nav);
    };

    // «Cerrar sesión» and the live tabs stream in after the frame.
    const mutation = new MutationObserver(() => {
      observeBoxes();
      update();
    });

    observeBoxes();
    mutation.observe(strip, { childList: true, subtree: true });
    strip.addEventListener("scroll", update, { passive: true });
    update();

    return () => {
      resize.disconnect();
      mutation.disconnect();
      strip.removeEventListener("scroll", update);
    };
  }, []);

  return (
    <div className="topbarEnd" ref={ref}>
      {children}
    </div>
  );
}

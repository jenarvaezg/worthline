"use client";

/**
 * SectionNav (#1190) — the workspace topnav tabs. Now that the chrome lives in
 * the shared `(workspace)` layout, the active tab is derived from the live URL
 * (`usePathname()` → `sectionForPath`) instead of being threaded as a prop from
 * every page. Thin client wiring over the pure `active-section` module — the same
 * composition as `form-submit-scroll-keeper.tsx` over `form-submit-scroll.ts`.
 */

import { usePathname } from "next/navigation";

import { type AppSection, NAV_SECTIONS, sectionForPath } from "./active-section";
import NavLink from "./nav-link";

export default function SectionNav() {
  const active: AppSection | null = sectionForPath(usePathname());

  return (
    <nav className="topNav" aria-label="Secciones principales">
      {NAV_SECTIONS.map((section) => (
        <NavLink
          className={`navTab${section.id === active ? " active" : ""}`}
          href={section.href}
          key={section.id}
        >
          {section.label}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * Static topnav links for the Instant Navigations shell (#1229). Same five
 * tabs as `SectionNav`, but without `usePathname()` / view-transition wiring —
 * used as the Suspense fallback so a cold load paints the nav immediately
 * instead of popping it in after hydration (no header CLS).
 */

import { NAV_SECTIONS } from "@web/active-section";
import Link from "next/link";

export default function SectionNavFallback() {
  return (
    <nav className="topNav" aria-label="Secciones principales">
      {NAV_SECTIONS.map((section) => (
        <Link className="navTab" href={section.href} key={section.id}>
          {section.label}
        </Link>
      ))}
    </nav>
  );
}

"use client";

import { useUrlViewParam } from "@web/url-view-state";
import { EXPOSURE_LENS_VIEW_PARAM, type ExposureLens } from "@web/view-state";
import { type ReactNode } from "react";

/**
 * The exposure geography lens as a client island (PRD #539 S3, #543, ADR 0036).
 *
 * The server pre-renders BOTH geography breakdowns — the full-portfolio
 * look-through and the equity-restricted one — plus the tabs' real `href`s; this
 * island shows the active one and switches instantly on click, no server
 * round-trip (interaction-patterns §2). It mirrors the exact shape of the Vista
 * framing island (`framing-panel.tsx`): the tabs stay real `<a href>` so they
 * deep-link, are keyboard-operable, and work with JS off (§3, §8); the island
 * only intercepts a plain left-click to swap client-side and mirror `exp` to the
 * URL via `history.pushState`. Back/Forward re-read the lens via `popstate`. The
 * among-state logic (which breakdown a lens shows) is the pure `exposure-view`
 * module — this is only the thin pushState/popstate shell.
 *
 * Read-only in demo: it toggles a view, never mutates, so no write-guard and no
 * optimism apply (§10).
 */

export interface ExposureLensTab {
  id: ExposureLens;
  label: string;
  /** Server-built URL for this lens — the no-JS fallback and the deep-link. */
  href: string;
}

export default function ExposureLensPanel({
  initialLens,
  tabs,
  all,
  equity,
}: {
  initialLens: ExposureLens;
  tabs: readonly ExposureLensTab[];
  all: ReactNode;
  equity: ReactNode;
}) {
  const [lens, , select] = useUrlViewParam(EXPOSURE_LENS_VIEW_PARAM, initialLens);

  const activeLabel = tabs.find((tab) => tab.id === lens)?.label ?? "";

  return (
    <>
      <nav className="framingTabs" aria-label="Lente de exposición">
        {tabs.map((tab) => {
          const isActive = tab.id === lens;
          return (
            <a
              aria-current={isActive ? "true" : undefined}
              className={isActive ? "active" : undefined}
              href={tab.href}
              key={tab.id}
              onClick={select(tab.id)}
            >
              {tab.label}
            </a>
          );
        })}
      </nav>
      {/* Announce the lens change for screen readers — a client toggle is not a
          document navigation, so it is not announced otherwise (§8). */}
      <p aria-live="polite" className="srOnly">{`Lente: ${activeLabel}`}</p>
      {lens === "equity" ? equity : all}
    </>
  );
}

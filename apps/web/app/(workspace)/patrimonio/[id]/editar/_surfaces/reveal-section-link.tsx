"use client";

/**
 * A link that reveals a collapsed section of THIS page instead of navigating to it
 * (#1365, ADR 0036, interaction-patterns §2/§3).
 *
 * Unfolding a `<details>` only changes which data you are looking at, so it must
 * not pay a round-trip. The anchor keeps a real `href` for progressive
 * enhancement — with no JS the server reads its param and renders the section open
 * — and with JS it opens the section in place, brings it into view, and mirrors the
 * href to the URL with `pushState`, so the state stays deep-linkable and Back
 * returns to the folded view (§3). The same pattern as the composition drill
 * (`donut-drill.tsx`).
 */

import { pushMirroredUrl, useViewStateSync } from "@web/url-view-state";
import { useCallback } from "react";

import { urlWantsRevealedSection } from "./reveal-section";

export function RevealSectionLink({
  children,
  href,
  sectionId,
}: {
  children: React.ReactNode;
  /** The no-JS destination, and what gets mirrored to the URL bar. */
  href: string;
  /** `id` of the element to reveal — every `<details>` around it is unfolded. */
  sectionId: string;
}) {
  // Back/Forward re-reads the URL: the section follows what the URL asks for, in
  // both directions. A user who folds the block by hand is untouched — this runs
  // only on a history event.
  useViewStateSync(
    useCallback(() => {
      setSectionRevealed(
        sectionId,
        urlWantsRevealedSection(window.location.search, href),
      );
    }, [href, sectionId]),
  );

  return (
    <a
      href={href}
      onClick={(event) => {
        // Let the browser navigate when the target is not on this page after all:
        // the server path renders it open, so the fallback is never a dead end.
        if (!document.getElementById(sectionId)) {
          return;
        }
        event.preventDefault();
        setSectionRevealed(sectionId, true);
        pushMirroredUrl(href);
        document
          .getElementById(sectionId)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
    >
      {children}
    </a>
  );
}

/** Unfold (or refold) every `<details>` enclosing the target section. */
function setSectionRevealed(sectionId: string, revealed: boolean): void {
  const target = document.getElementById(sectionId);
  for (let node = target; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) {
      node.open = revealed;
    }
  }
}

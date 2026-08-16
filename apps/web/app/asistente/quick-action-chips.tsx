"use client";

import NavLink from "@web/nav-link";

import type { QuickAction } from "./assistant-actions";

/**
 * The follow-up chip row (#631, ADR 0053), one component for both surfaces — the
 * floating panel and the onboarding screen — so they cannot drift apart.
 *
 * The two typed actions are two different HTML elements, and that is the point:
 *
 *   - `openInternalSource` is a NAVIGATION, so it is an anchor
 *     ({@link NavLink}, the repo's own link). As a `<button>` it looked
 *     like a link, navigated like a link and behaved like neither: no destination
 *     on hover or in the status bar, no ⌘-click into a new tab, and — the reported
 *     complaint — no in-flight signal at all. Opening a source is an RSC fetch of a
 *     second or two, and the panel stays mounted over the page it came from, so a
 *     click produced no visible change whatsoever. The anchor brings all three for
 *     free: Next prefetches it, `useLinkStatus` spins the `.navPending` ring
 *     (#607) while the payload lands, and the destination is a real href the model
 *     never chose (`assistant-actions.ts` resolved it to an internal path).
 *   - `runSuggestedAnalysis` sends a message. That is an action, not a place, so it
 *     stays a `<button>`.
 */
export default function QuickActionChips({
  actions,
  onRun,
}: {
  actions: readonly QuickAction[];
  onRun: (prompt: string) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div aria-label="Acciones sugeridas" className="assistantActions" role="group">
      {actions.map((action, i) =>
        action.type === "openInternalSource" ? (
          <NavLink
            className="assistantChip openInternalSource"
            href={action.href}
            key={`${action.label}-${i}`}
          >
            {action.label}
          </NavLink>
        ) : (
          <button
            className="assistantChip runSuggestedAnalysis"
            key={`${action.label}-${i}`}
            onClick={() => onRun(action.prompt)}
            type="button"
          >
            {action.label}
          </button>
        ),
      )}
    </div>
  );
}

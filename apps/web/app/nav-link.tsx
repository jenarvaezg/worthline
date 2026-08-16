"use client";

/**
 * NavLink — a topnav/quick-action link that paints an in-flight marker while its
 * navigation is pending (#607, interaction-patterns §4).
 *
 * This is what survived `ViewTransitionLink` after #1379 retired the View
 * Transitions layer. The transition wiring it used to carry never ran: React
 * only opens a view transition from inside a `<ViewTransition>` boundary, and
 * the app has none, so `transitionTypes` was queued for a transition that never
 * started. The pending indicator lives in the same component but does not depend
 * on any of that — it reads Next's `useLinkStatus()`, which is why it kept
 * working while the rest of the layer was inert.
 *
 * See ADR 0036 §5 for why the layer was retired rather than revived.
 */

import Link, { useLinkStatus } from "next/link";

/**
 * `transitionTypes` is omitted on purpose. Next's `Link` typings still declare it
 * whether or not `experimental.viewTransition` is set, so without this a caller
 * could pass it, get no type error, and get no transition either — the exact
 * silent inertness #1379 retired. Making it untypeable turns that back into a
 * compile error.
 */
export interface NavLinkProps
  extends Omit<React.ComponentProps<typeof Link>, "transitionTypes" | "href"> {
  /** href must be a string pathname (topnav links always are). */
  href: string;
}

/**
 * Pure in-flight marker for a section link (#607, interaction-patterns §4).
 * Renders a small spinner while a navigation is pending, nothing once settled.
 * `aria-hidden` because the visual state is decorative — the route change itself
 * is what a screen reader announces. Animation respects `prefers-reduced-motion`
 * via the blanket rule in globals.css (collapses to a static ring, still visible).
 */
export function NavPendingIndicator({ pending }: { pending: boolean }) {
  return pending ? <span aria-hidden="true" className="navPending" /> : null;
}

/** Thin wiring shell: reads Next 16's `useLinkStatus` (only valid inside a Link). */
function NavPending() {
  const { pending } = useLinkStatus();
  return <NavPendingIndicator pending={pending} />;
}

export default function NavLink({ href, children, ...rest }: NavLinkProps) {
  return (
    <Link {...rest} href={href}>
      {children}
      <NavPending />
    </Link>
  );
}

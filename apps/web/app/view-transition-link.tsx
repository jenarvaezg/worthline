"use client";

/**
 * ViewTransitionLink — thin client shell that wires the pure eligibility module
 * (`view-transitions.ts`) to actual Next.js route navigations (#517,
 * interaction-patterns §5, ADR 0036).
 *
 * Pattern: same composition as `composition-chart-hover.ts` §7 — the pure
 * module holds all logic, the client island holds only the wiring.
 *
 * How it works:
 *   1. At render time, `classifyTransition(pathname, href)` determines whether
 *      the navigation is eligible and which CSS transition-type tokens to use.
 *   2. If eligible and the browser supports the API, the classified types are
 *      passed to `<Link transitionTypes={...}>` — Next 16's native prop that
 *      threads the types through to `document.startViewTransition` automatically.
 *   3. If not eligible or the browser does not support the API, `transitionTypes`
 *      is `undefined` and Next renders a plain link with no transition overhead.
 *
 * Graceful degradation: `supportsViewTransitions()` returns false in non-browser
 * environments (SSR/node).  `transitionTypes` is NOT rendered to the DOM (Next
 * destructures it out before spreading to the anchor), so returning `undefined`
 * on SSR and a real array on the client does NOT cause a hydration mismatch.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { classifyTransition, supportsViewTransitions } from "./view-transitions";

export interface ViewTransitionLinkProps extends React.ComponentProps<typeof Link> {
  /** href must be a string pathname (topnav links always are). */
  href: string;
}

export default function ViewTransitionLink({ href, ...rest }: ViewTransitionLinkProps) {
  const pathname = usePathname();
  const { eligible, transitionTypes } = classifyTransition(pathname, href);
  const vtProps =
    supportsViewTransitions() && eligible ? { transitionTypes } : ({} as object);

  // rest spread first so our computed href/transitionTypes win over any caller value.
  return <Link {...rest} href={href} {...vtProps} />;
}

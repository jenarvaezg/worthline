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
 *   1. `onNavigate` fires before Next.js performs the SPA navigation.
 *   2. We read the current pathname via `usePathname()` (always fresh because
 *      this renders client-side) and classify the transition.
 *   3. If not eligible or the browser does not support the API → let the
 *      default Next navigation proceed (no `preventDefault`, no transition).
 *   4. If eligible → `e.preventDefault()` stops Next's default push, then we
 *      issue `router.push(href, { transitionTypes })` with the classified type
 *      so the CSS `::view-transition-old(.slide-forward)` selectors fire.
 *
 * Graceful degradation: `supportsViewTransitions()` returns false in browsers
 * without the API (and in SSR) — the component renders a plain `next/link`
 * in those cases with zero extra runtime cost.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { classifyTransition, supportsViewTransitions } from "./view-transitions";

export interface ViewTransitionLinkProps extends React.ComponentProps<typeof Link> {
  /** href must be a string pathname (topnav links always are). */
  href: string;
}

export default function ViewTransitionLink({
  href,
  onNavigate,
  ...rest
}: ViewTransitionLinkProps) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <Link
      href={href}
      onNavigate={(e) => {
        // Forward any caller-supplied onNavigate first, tracking whether it
        // called preventDefault (the type has no defaultPrevented field).
        let prevented = false;
        const wrapped = {
          preventDefault: () => {
            prevented = true;
            e.preventDefault();
          },
        };
        onNavigate?.(wrapped);
        if (prevented) return;

        if (!supportsViewTransitions()) return;

        const { eligible, transitionTypes } = classifyTransition(pathname, href);
        if (!eligible) return;

        // Hand off to router.push with the classified transition types so the
        // CSS `::view-transition-old(.slide-forward)` selectors fire.
        e.preventDefault();
        router.push(href, { transitionTypes });
      }}
      {...rest}
    />
  );
}

"use client";

/**
 * ScopeReturnInput (#1190) — the hidden `returnTo` for the scope-switch POST.
 * The scope bar now lives in the shared layout, which cannot read the page's
 * search params, so the return URL is built from the live URL client-side
 * (mirroring what pages passed as `currentPageUrl` before): the current path
 * plus its carried-forward query params, with one-shot feedback params stripped
 * via the shared `buildCurrentUrlFor`.
 */

import { usePathname, useSearchParams } from "next/navigation";

import { buildCurrentUrlFor } from "./current-url";

export default function ScopeReturnInput() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const params: Record<string, string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    (params[key] ??= []).push(value);
  }
  const returnTo = buildCurrentUrlFor(pathname, params);

  return <input name="returnTo" type="hidden" value={returnTo} />;
}

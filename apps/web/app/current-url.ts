/**
 * Current-URL builder (#1190): the pure, framework-agnostic rules for the
 * canonical "return here" URL — the page's own path with every one-shot
 * feedback param stripped, so banners and preserved form values never persist
 * across later navigation.
 *
 * Extracted from `intake.ts` so it can be imported from both server pages and
 * the `ScopeReturnInput` client island (the shared scope bar builds its POST
 * `returnTo` from the live URL) without pulling the rest of `intake` — and its
 * server-leaning re-exports — into the client bundle. Single source of truth:
 * `intake.ts` re-exports these.
 */

/** One-shot post-redirect feedback params — never carried forward in currentUrl. */
export const ONE_SHOT_PARAMS = new Set([
  "ok",
  "error",
  "form",
  "updated",
  "failed",
  "anchor",
  // Statement-load summary (#174, #175, #178, #179): counts shown once in the banner.
  "created",
  "overwritten",
  "skipped",
  "anomalies",
  "sells",
  // Symbol-search state (#138): the query and the picked candidate's prefill
  // live in the URL only while the user is choosing — never carried into the
  // action return URL.
  "symbolq",
  "pfName",
  "pfSymbol",
  "pfProvider",
  // Onboarding re-run trigger (#1170): a one-shot activation flag consumed by the
  // assistant layer; never carried into action-return URLs or the sibling links.
  "repasar",
]);

export const PRESERVED_VALUE_PREFIX = "v_";

function isCarriedForward(key: string): boolean {
  return !ONE_SHOT_PARAMS.has(key) && !key.startsWith(PRESERVED_VALUE_PREFIX);
}

/**
 * buildCurrentUrlFor: rebuild a "return here" URL for `basePath` from the page's
 * search params, dropping every one-shot feedback param so subpages
 * (/patrimonio/[id]/editar, etc.) get the right return URL without knowing the
 * page URL at parse time.
 */
export function buildCurrentUrlFor(
  basePath: string,
  searchParams?: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams();

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined) continue;
      if (!isCarriedForward(key)) continue;

      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, item);
        }
      } else {
        params.set(key, value);
      }
    }
  }

  const queryString = params.toString();

  return queryString ? `${basePath}?${queryString}` : basePath;
}

/** Like {@link buildCurrentUrlFor} but pinned to the dashboard (`/app`). */
export function buildCurrentUrl(
  searchParams?: Record<string, string | string[] | undefined>,
): string {
  return buildCurrentUrlFor("/app", searchParams);
}

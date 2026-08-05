/**
 * The reveal-a-collapsed-section link, decided in pure code (#1365, ADR 0036).
 *
 * The danger zone offers "registrar la venta", and the operations surface it points
 * at is already server-rendered — just folded inside `<details>`. Revealing it is
 * ephemeral view state (interaction-patterns §1), so it must not cost a
 * navigation; but the same href has to keep working with no JS, where the server
 * reads the param and renders the block open. Both halves read the SAME question
 * from here, so the link and the server can never disagree about what the URL asks
 * for.
 */

/**
 * Whether a live URL asks for the section this href reveals — true when every
 * search param the href sets is present with the same value in `liveSearch`.
 * Derived from the href rather than passed as a param/value pair so the link,
 * the popstate sync, and the server all read one source: the href itself.
 */
export function urlWantsRevealedSection(liveSearch: string, href: string): boolean {
  const wanted = new URLSearchParams(hrefSearch(href));
  if ([...wanted.keys()].length === 0) {
    return false;
  }

  const live = new URLSearchParams(liveSearch);
  for (const [key, value] of wanted) {
    if (live.get(key) !== value) {
      return false;
    }
  }
  return true;
}

/** The `?…` slice of a relative or absolute href, without its fragment. */
function hrefSearch(href: string): string {
  const afterFragment = href.split("#")[0] ?? "";
  const queryStart = afterFragment.indexOf("?");
  return queryStart === -1 ? "" : afterFragment.slice(queryStart + 1);
}

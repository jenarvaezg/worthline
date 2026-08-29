/**
 * Which managed-portfolio groups are unfolded on the board (#1548).
 *
 * URL state, not a client secret (interaction-patterns §3): the open set lives
 * in `?carteras=`, so the server renders the right thing on load — no flash of
 * a collapsed group that snaps open after hydration — and a link to «the board
 * with the Metal open» is shareable. Pure functions only; the pushState shell
 * is the island's job (§7 — the `composition-chart-hover` split).
 *
 * The param carries PUBLIC portfolio ids (`wl_prt_…`, #1318): an internal id in
 * a URL is a leak, and this is a URL.
 */

/** The query param that carries the unfolded portfolios. */
export const BOARD_FOLD_PARAM = "carteras";

/** A public id as it may appear in the param — anything else is ignored. */
const PUBLIC_ID = /^wl_prt_[A-Za-z0-9]+$/;

/**
 * The unfolded set as written in a query string. Unknown, malformed or
 * duplicated entries are dropped rather than rejected: a hand-edited URL should
 * degrade to a collapsed board, never to an error page.
 */
export function readOpenPortfolios(search: URLSearchParams): ReadonlySet<string> {
  const raw = search.get(BOARD_FOLD_PARAM);
  if (!raw) return new Set();
  return new Set(raw.split(",").filter((id) => PUBLIC_ID.test(id)));
}

/** The same, from a full URL or a bare query string. */
export function readOpenPortfoliosFromUrl(url: string): ReadonlySet<string> {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  return readOpenPortfolios(new URLSearchParams(query));
}

/** Flip one portfolio's fold, returning a NEW set (never mutating the old). */
export function toggleOpenPortfolio(
  open: ReadonlySet<string>,
  publicId: string,
): ReadonlySet<string> {
  const next = new Set(open);
  if (!next.delete(publicId)) {
    next.add(publicId);
  }
  return next;
}

/**
 * `url` with the fold param rewritten to `open`. The param disappears when the
 * set is empty, so the collapsed board — the default — has a clean URL and the
 * Back stack does not fill with `?carteras=`.
 *
 * The ids are sorted so the same open set always produces the same URL: two
 * routes to the same board must not look like two different pages to history.
 */
export function urlWithOpenPortfolios(url: string, open: ReadonlySet<string>): string {
  const [path, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  if (open.size === 0) {
    params.delete(BOARD_FOLD_PARAM);
  } else {
    params.set(BOARD_FOLD_PARAM, [...open].sort().join(","));
  }
  // `URLSearchParams` percent-encodes the separator (`%2C`), which parses back
  // identically but turns a shared link into noise. A comma is a legal
  // sub-delimiter in a query, so put it back — only inside our own param.
  const rest = params
    .toString()
    .replace(
      new RegExp(`(^|&)${BOARD_FOLD_PARAM}=([^&]*)`),
      (_match, prefix: string, value: string) =>
        `${prefix}${BOARD_FOLD_PARAM}=${value.replaceAll("%2C", ",")}`,
    );
  return rest ? `${path}?${rest}` : (path ?? "");
}

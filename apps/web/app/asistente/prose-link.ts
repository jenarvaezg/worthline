/**
 * Which link the assistant's prose is allowed to make clickable (#1289).
 *
 * The assistant has two ways to send the user somewhere, and only one of them had
 * a boundary. `suggest_actions` is typed: the tool resolves a reference to an
 * internal surface and the app decides the destination, so — as
 * `assistant-actions.ts` states — «the model never hands over a raw URL». A
 * markdown link in the prose went around all of that: streamdown's own pipeline
 * ships `allowedLinkPrefixes: ["*"]` and `allowedProtocols: ["*"]`, so the only
 * thing between an injected turn and a clickable link to any host was streamdown's
 * `linkSafety` modal — an English «Open external link?» that also called worthline's
 * own `/patrimonio` an external website. A nag, not a frontier.
 *
 * So the rule mirrors the one #1246 wrote for images, one layer over: an internal
 * path stays a link and navigates like the typed chip does; anything else is not a
 * link at all — the text survives, the href does not. There is no host allowlist to
 * get wrong, and the prose channel gains no capability `suggest_actions` lacks.
 * `rehype-sanitize` already kept `javascript:` out of hrefs, so this was never an
 * XSS boundary: what it closes is phishing and exfiltration by click.
 *
 * The one subtle part is what «internal» means, and it is subtle enough to be code
 * with tests rather than a glance: `//evil.tld/x` starts with a slash and is a
 * protocol-relative URL to another origin, `/\evil.tld` is treated the same way by
 * browsers that fold the backslash, and the URL parser DELETES tabs and newlines
 * before resolving — so `/<tab>/evil.tld` becomes `//evil.tld` after parsing but not
 * before, if you check the raw string.
 */

/** Tab, LF and CR: removed by the URL parser, so removed before deciding. */
const URL_STRIPPED_CHARACTERS = /[\t\n\r]/g;

/** One leading slash, and the next character may not open an authority. */
const INTERNAL_PATH = /^\/(?![/\\])/;

/**
 * The path to navigate to when this href is an internal worthline route, or `null`
 * when the link must not be a link. Returns the CLEANED path, never the raw string:
 * what gets navigated to has to be what was validated.
 */
export function internalProseLinkHref(href: string | undefined): string | null {
  if (href === undefined) return null;
  const cleaned = href.replace(URL_STRIPPED_CHARACTERS, "").trim();
  return INTERNAL_PATH.test(cleaned) ? cleaned : null;
}

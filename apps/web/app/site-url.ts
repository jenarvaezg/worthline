/**
 * Canonical public origin of worthline (PRD #877 S6, #954). One place resolves
 * the absolute base used by the SEO surfaces — `metadataBase`, canonical links,
 * Open Graph URLs, `robots.txt` and the sitemap — so they never disagree.
 *
 * Overridable per environment via `NEXT_PUBLIC_SITE_URL` (inlined at build, so
 * the static landing / robots / sitemap stay prerenderable); defaults to the
 * production deploy. The trailing slash is trimmed so callers can concatenate
 * paths (`${SITE_URL}/demo`) without doubling it.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://worthline-web.vercel.app"
).replace(/\/+$/, "");

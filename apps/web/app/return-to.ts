/** Gated product entry — the dashboard and its default post-login destination. */
export const DEFAULT_APP_PATH = "/app";

/**
 * Validate a `returnTo` query param: only same-origin relative paths are
 * accepted. Rejects absolute URLs (`https://…`) and protocol-relative paths
 * (`//evil.com`) to block open redirects.
 */
export function parseReturnTo(
  raw: string | undefined | null,
  fallback: string = DEFAULT_APP_PATH,
): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }
  return fallback;
}

/** Build `/login?returnTo=…` for an unauthenticated gate redirect. */
export function buildLoginRedirectUrl(
  origin: string,
  pathname: string,
  search = "",
): URL {
  const url = new URL("/login", origin);
  url.searchParams.set("returnTo", parseReturnTo(`${pathname}${search}`));
  return url;
}

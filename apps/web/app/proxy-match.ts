import { isPublicPath } from "./auth-gate";

/**
 * Paths the Node proxy lambda must not run on (#1536). Statics, well-known,
 * cron, Auth.js, MCP and the public pages are reachable without a session, so
 * invoking the lambda (and decrypting a JWT) is pure cold-start tax.
 *
 * Gated pages — including a logged-out demo on `/patrimonio` that carries the
 * persona cookie — still match; that cookie is checked inside the proxy.
 *
 * Next.js matchers cannot call a function, so this string is the matcher and
 * {@link shouldInvokeProxy} is the same decision for the handler. `proxy-match.test.ts`
 * pins them against each other.
 */
export const PROXY_MATCHER =
  "/((?!_next/static|_next/image|favicon.ico|api/cron|api/auth|api/mcp|\\.well-known|login(?:/|$)|demo(?:/|$)|.*\\.(?:ico|png|svg|jpe?g|gif|webp|json|js|txt|xml|map|webmanifest|woff2?)$).+)";

const STATIC_EXT =
  /\.(?:ico|png|svg|jpe?g|gif|webp|json|js|txt|xml|map|webmanifest|woff2?)$/i;

/** Whether `proxy.ts` should run (and verify a JWT) for this pathname. */
export function shouldInvokeProxy(pathname: string): boolean {
  if (pathname.startsWith("/_next/static") || pathname.startsWith("/_next/image")) {
    return false;
  }
  if (pathname === "/favicon.ico" || STATIC_EXT.test(pathname)) return false;
  return !isPublicPath(pathname);
}

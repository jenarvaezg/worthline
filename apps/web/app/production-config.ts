/**
 * Boot-time deploy-config guard for the hosted deployment (#1181). Sibling of
 * `./encryption-config`: both run once from `instrumentation.ts` so a
 * misconfigured deploy dies at startup instead of serving something unsafe.
 *
 * The hazard this closes: every access decision in the app treats "no
 * `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`" as **local single-user mode** —
 * `shouldRedirectToLogin` returns `false` for every path, `resolveStoreTarget`
 * resolves to `{ kind: "local" }`, and `/api/mcp` falls through to the
 * unauthenticated handler with no OAuth gate (ADR 0030, ADR 0034). That is
 * exactly right on a laptop and catastrophic on a public deploy: the whole app,
 * including the agent surface, would be served open to the internet. Rather than
 * teach each of those sites a second mode, the deploy is refused up front.
 *
 * Pure over an env bag (no `process.env` read, no I/O) so the whole decision is
 * unit-testable and the module stays safe to import from anywhere.
 */

/**
 * The vars a Vercel production deploy cannot serve a single correct request
 * without: the Google provider + Auth.js signing secret (without them the app
 * silently degrades to open local mode), the control-plane coordinates (without
 * them no workspace can be resolved or opened), and the Turso Platform
 * credentials provision-on-first-login writes with (without them every new
 * user's first sign-in fails — see `provisionWorkspaceForEmail`).
 */
const REQUIRED_PRODUCTION_ENV = [
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AUTH_SECRET",
  "WORTHLINE_CONTROL_PLANE_DB_URL",
  "WORTHLINE_DB_AUTH_TOKEN",
  "TURSO_ORG",
  "TURSO_API_TOKEN",
] as const;

/** The pair whose presence — and only whose presence — turns auth on anywhere. */
const GOOGLE_AUTH_PAIR = ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"] as const;

/**
 * Whether this process is a Vercel **production** deploy.
 *
 * Deliberately NOT keyed on `NODE_ENV`: `NODE_ENV=production` is also how the
 * supported local single-user mode runs (`next start` on a laptop, README
 * "Local no-auth mode") and how CI serves the e2e suite — both legitimately have
 * no auth configured, so treating it as the production signal would abort boots
 * that are working as designed. `VERCEL_ENV` is set only by the hosted platform,
 * at build and at runtime in prebuilt deploys alike (the same signal ADR 0061's
 * provider-cooldown scope already relies on), which is the deploy at risk.
 * The `NODE_ENV`-only hosted deploy is covered instead by
 * {@link halfConfiguredAuth}, which needs no environment signal at all.
 *
 * Preview deploys are out of scope: the repo ships production-only
 * (`deploy.yml`), and a future preview pipeline shouldn't be blocked by a guard
 * written for the public deploy. Widening it later is cheap — the Preview scope
 * already carries all of {@link REQUIRED_PRODUCTION_ENV} (verified 2026-07-26) —
 * so do it the day previews actually serve real data.
 *
 * This is a different question from `encryption-config`'s "is auth configured?",
 * and the two must not be merged: that guard protects any process writing
 * secrets to a remote store — including a developer running hosted mode locally
 * — while this one protects the public deploy. Same boot, different blast radii.
 */
function isProductionDeploy(env: Record<string, string | undefined>): boolean {
  return env.VERCEL_ENV?.trim() === "production";
}

/**
 * A var counts as missing when unset, empty, or whitespace-only. Vercel reads a
 * cleared var as `""`, and a stray-whitespace value is never a real credential;
 * both are treated as absent so a deploy can't look configured while behaving as
 * if it were not.
 */
function isBlank(value: string | undefined): boolean {
  return (value ?? "").trim() === "";
}

/**
 * Exactly one half of the Google pair set — a state that is never valid in any
 * environment: auth was clearly intended, yet every gate reads the pair as
 * absent and serves the app wide open. Catches the case `VERCEL_ENV` cannot (a
 * self-hosted `NODE_ENV=production` deploy, or a typo'd var name) without
 * touching the two legitimate no-auth setups, which leave BOTH blank.
 */
function halfConfiguredAuth(env: Record<string, string | undefined>): boolean {
  const set = GOOGLE_AUTH_PAIR.filter((name) => !isBlank(env[name]));
  return set.length === 1;
}

/**
 * Every reason this env is unsafe to boot, as operator-facing sentences — empty
 * when the process may start. One pure decision, so the assertion below is a
 * thin adapter and the tests never have to parse prose.
 */
export function bootRefusals(env: Record<string, string | undefined>): string[] {
  const refusals: string[] = [];

  if (isProductionDeploy(env)) {
    const missing = REQUIRED_PRODUCTION_ENV.filter((name) => isBlank(env[name]));
    if (missing.length > 0) {
      refusals.push(
        `this production deploy is missing ${missing.join(", ")} — without the ` +
          "auth and control-plane configuration the app falls back to local " +
          "no-auth mode and would serve every page, /api/mcp included, with no " +
          "sign-in wall. Set them in the Vercel Production scope and redeploy.",
      );
    }
  }

  if (halfConfiguredAuth(env)) {
    refusals.push(
      `only one of ${GOOGLE_AUTH_PAIR.join(" / ")} is set — Google sign-in needs ` +
        "both, so every gate reads auth as disabled and serves the app with no " +
        "sign-in wall. Set both, or neither for local no-auth mode.",
    );
  }

  return refusals;
}

/**
 * Refuse to boot a deploy whose auth / control-plane configuration would leave
 * the app open. No-op on a correctly configured deploy and in local no-auth
 * mode, so laptop runs and the e2e suite start exactly as they do today.
 */
export function assertProductionConfigured(
  env: Record<string, string | undefined>,
): void {
  const refusals = bootRefusals(env);
  if (refusals.length === 0) return;

  throw new Error(`Refusing to boot (ADR 0030, #1181): ${refusals.join(" Also, ")}`);
}

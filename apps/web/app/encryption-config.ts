import { ENCRYPTION_KEY_ENV } from "@worthline/db";

/**
 * Deploy-config guard (S6 #387, ADR 0030). In the hosted deployment connected-
 * source secrets are written to a remote Turso database and MUST be encrypted at
 * rest; without the key the crypto seam silently degrades to plaintext. Fail the
 * deploy fast instead — run once from `instrumentation.ts` at server startup.
 *
 * "Hosted" is signalled by Google auth being configured (the same signal the
 * store seam and middleware use). Local no-auth mode keeps secrets on a local
 * file and needs no key, so it is a no-op there.
 */
export function assertSecretEncryptionConfigured(
  env: Record<string, string | undefined>,
): void {
  const authConfigured = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
  if (authConfigured && !env[ENCRYPTION_KEY_ENV]) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} must be set in the hosted deployment — connected-source ` +
        "secrets would otherwise reach Turso in plaintext (ADR 0030, #387).",
    );
  }
}

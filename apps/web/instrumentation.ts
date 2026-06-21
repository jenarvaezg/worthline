/**
 * Next.js startup hook (runs once per server boot per runtime, never at build or
 * in tests). Fails the hosted deployment fast when the connected-source
 * encryption key is missing, so secrets can never silently reach Turso in
 * plaintext (ADR 0030).
 *
 * Gated to the Node.js runtime: the check imports `@worthline/db` (for the env
 * key name), which pulls in `node:fs`/libsql and cannot load in the Edge runtime
 * that the proxy also boots — so it is dynamically imported only when
 * `NEXT_RUNTIME === "nodejs"`, keeping it out of the Edge bundle entirely.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertSecretEncryptionConfigured } = await import("@web/encryption-config");
  assertSecretEncryptionConfigured(process.env);
}

/**
 * Next.js startup hook (runs once per server boot per runtime, never at build or
 * in tests). Fails a misconfigured hosted deployment fast, on two counts:
 *
 * 1. A production deploy without its auth / control-plane configuration would
 *    fall back to local no-auth mode and serve the whole app — `/api/mcp`
 *    included — with no sign-in wall (#1181).
 * 2. A hosted deployment without the connected-source encryption key would let
 *    secrets reach Turso in plaintext (ADR 0030).
 *
 * The auth assertion runs first: it is the root misconfiguration, and its
 * message is the actionable one (the encryption guard keys off auth being
 * configured, so it would stay silent in exactly that deploy).
 *
 * Gated to the Node.js runtime: the encryption check imports `@worthline/db`
 * (for the env key name), which pulls in `node:fs`/libsql and cannot load in the
 * Edge runtime that the proxy also boots — so both are dynamically imported only
 * when `NEXT_RUNTIME === "nodejs"`, keeping them out of the Edge bundle entirely.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionConfigured } = await import("@web/production-config");
  assertProductionConfigured(process.env);
  const { assertSecretEncryptionConfigured } = await import("@web/encryption-config");
  assertSecretEncryptionConfigured(process.env);
  // First request of each isolate used to pay the require of the dashboard
  // path (@libsql/client, drizzle-orm/libsql, big.js) — ~560 ms measured for
  // big.js alone (#1235). Load them here, off the request (#1536).
  const { preheatLibsqlStack } = await import("@worthline/db");
  preheatLibsqlStack();
  await import("big.js");
}

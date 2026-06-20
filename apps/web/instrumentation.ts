import { assertSecretEncryptionConfigured } from "@web/encryption-config";

/**
 * Next.js startup hook (runs once per server boot, never at build or in tests).
 * Fails the hosted deployment fast when the connected-source encryption key is
 * missing, so secrets can never silently reach Turso in plaintext (ADR 0030).
 */
export function register(): void {
  assertSecretEncryptionConfigured(process.env);
}

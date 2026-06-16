/**
 * Pure helpers for the Binance connected-source flow (PRD #245, ADR 0021). They
 * shape and read back the stored credentials (an API key + signing secret). Kept
 * free of Next.js, the store, and the network so the connect/sync actions stay
 * thin glue and these decisions are unit-testable.
 *
 * The API key AND secret are SECRETS (ADR 0021): they are serialized into
 * credentialsJson for the local DB only — never logged and never placed in a
 * redirect URL. The secret can sign actions, so the connect form requires a
 * READ-ONLY key; these helpers never validate that scope (the API does), they
 * only carry the pasted values losslessly.
 *
 * Ownership resolution and last-sync formatting are generic across adapters, so
 * they are re-exported from numista-helpers rather than duplicated.
 */

export { formatLastSync, resolveConnectingOwnership } from "./numista-helpers";

/** Local-only Binance credentials: an API key + the HMAC signing secret. */
export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

/**
 * Normalize the pasted key + secret, returning null when either is blank. Both
 * are trimmed; a Binance source needs both (the key for the header, the secret
 * for signing), so a missing half is a no-go.
 */
export function normalizeBinanceCredentials(
  apiKey: FormDataEntryValue | null,
  apiSecret: FormDataEntryValue | null,
): BinanceCredentials | null {
  const key = String(apiKey ?? "").trim();
  const secret = String(apiSecret ?? "").trim();
  if (key === "" || secret === "") {
    return null;
  }
  return { apiKey: key, apiSecret: secret };
}

/** Serialize the Binance credentials for local storage (never logged/exported). */
export function buildBinanceCredentialsJson(apiKey: string, apiSecret: string): string {
  return JSON.stringify({ apiKey, apiSecret });
}

/** Read the stored key + secret back out of a source's credentialsJson, or null
 *  when the JSON is malformed or either half is missing/blank. */
export function readBinanceCredentials(
  credentialsJson: string,
): BinanceCredentials | null {
  try {
    const parsed = JSON.parse(credentialsJson) as {
      apiKey?: unknown;
      apiSecret?: unknown;
    };
    const key = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    const secret = typeof parsed.apiSecret === "string" ? parsed.apiSecret.trim() : "";
    if (key === "" || secret === "") {
      return null;
    }
    return { apiKey: key, apiSecret: secret };
  } catch {
    return null;
  }
}

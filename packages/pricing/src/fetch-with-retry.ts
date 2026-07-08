/**
 * Bounded HTTP retry with exponential backoff (issue #730).
 *
 * Retries transient HTTP statuses (429, 5xx) and network/timeout throws so a
 * momentary provider blip does not immediately degrade to null/empty. Used by
 * every external price fetch in the pricing package.
 */

/** HTTP statuses that warrant a retry (rate limits and server errors). */
export const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class HttpTransientError extends Error {
  constructor(readonly status: number) {
    super(`Transient HTTP ${status}`);
    this.name = "HttpTransientError";
  }
}

export interface RetryOptions {
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Base delay before the second attempt in ms (default 200; doubles each retry). */
  baseDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` up to `maxAttempts` times with exponential backoff. Re-throws the
 * last error when all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/**
 * `fetch` with bounded retry on transient HTTP statuses and network errors.
 * Non-transient HTTP errors (e.g. 404) return the response as-is for the caller
 * to handle.
 */
export async function fetchHttpWithRetry(
  url: string | URL,
  init?: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  return withRetry(async () => {
    try {
      const res = await fetch(url, init);
      if (!res.ok && TRANSIENT_HTTP_STATUSES.has(res.status)) {
        throw new HttpTransientError(res.status);
      }
      return res;
    } catch (err) {
      if (err instanceof HttpTransientError) throw err;
      // Network errors, timeouts (AbortError), etc. — retry.
      throw err;
    }
  }, options);
}

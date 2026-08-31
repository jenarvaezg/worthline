/**
 * Bounded HTTP retry with exponential backoff (issue #730, universalized in #1694).
 *
 * Retries transient HTTP statuses (429, 5xx) and network/timeout throws so a
 * momentary provider blip does not immediately degrade to null/empty.
 *
 * Coverage (the claim this comment used to make falsely — #1694): every external
 * HTTP call in the pricing package goes through {@link fetchHttpWithRetry},
 * EXCEPT the five signed Binance endpoints in `binance.ts`, which document their
 * own exclusion at the call site: their `timestamp` is baked into the signed
 * query, so a retried request re-presents a stale one and Binance rejects
 * anything past its `recvWindow`.
 */

/** HTTP statuses that warrant a retry (rate limits and server errors). */
export const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * The same set minus 429 — for a provider whose rate limit a retry burst only
 * digs deeper. CoinGecko's public tier (no key) is the case in this repo: its
 * window never moves inside a 200/400ms backoff, so three attempts spend three
 * requests to earn the same 429. A caller that degrades cheaply (a logo, a
 * search suggestion) opts out with this set.
 */
export const TRANSIENT_HTTP_STATUSES_EXCEPT_RATE_LIMIT = new Set([
  408, 500, 502, 503, 504,
]);

/**
 * The deadline one external pricing request gets, shared so it is not a literal
 * re-typed at every call site. Per ATTEMPT, not per call: a retry is a new
 * request and deserves its own budget.
 */
export const PRICING_FETCH_TIMEOUT_MS = 8_000;

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

export interface FetchRetryOptions extends RetryOptions {
  /**
   * Per-attempt deadline (default {@link PRICING_FETCH_TIMEOUT_MS}). Ignored when
   * `init.signal` is set: a caller that brought its own signal owns cancellation.
   */
  timeoutMs?: number;
  /** Which statuses earn another attempt (default {@link TRANSIENT_HTTP_STATUSES}). */
  retryStatuses?: ReadonlySet<number>;
  /** The `fetch` to call — for the readers that publish an injectable `fetchImpl`. */
  fetchImpl?: typeof fetch;
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
 *
 * Each attempt gets a FRESH deadline. A caller that built one
 * `AbortSignal.timeout()` and handed it in via `init` would share a single budget
 * across every attempt: after the first timeout the retries would fire against an
 * already-aborted signal and fail instantly, which is how the retry silently did
 * nothing for the very failure it exists for (#1694).
 *
 * Exhausting the attempts on a transient STATUS returns that last response — it
 * does not throw. This is what makes the helper droppable into any call site
 * (#1694): every provider already decides what a non-OK response means for it (a
 * null price, a typed failure reason, a thrown series error), and the retry must
 * only delay that decision, never replace it with an exception the caller never
 * handled. A network error or timeout has no response and still throws, exactly
 * as a bare `fetch` does.
 */
export async function fetchHttpWithRetry(
  url: string | URL,
  init?: RequestInit,
  options?: FetchRetryOptions,
): Promise<Response> {
  const retryStatuses = options?.retryStatuses ?? TRANSIENT_HTTP_STATUSES;
  const timeoutMs = options?.timeoutMs ?? PRICING_FETCH_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl ?? fetch;
  let lastTransientResponse: Response | undefined;

  try {
    return await withRetry(async () => {
      const res = await fetchImpl(url, {
        ...init,
        ...(init?.signal ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
      });
      if (!res.ok && retryStatuses.has(res.status)) {
        lastTransientResponse = res;
        throw new HttpTransientError(res.status);
      }
      return res;
    }, options);
  } catch (err) {
    if (err instanceof HttpTransientError && lastTransientResponse) {
      return lastTransientResponse;
    }
    throw err;
  }
}

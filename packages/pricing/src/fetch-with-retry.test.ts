import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchHttpWithRetry,
  HttpTransientError,
  PRICING_FETCH_TIMEOUT_MS,
  TRANSIENT_HTTP_STATUSES,
  TRANSIENT_HTTP_STATUSES_EXCEPT_RATE_LIMIT,
  withRetry,
} from "./fetch-with-retry";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns on the first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures with exponential backoff", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { baseDelayMs: 100, maxAttempts: 3 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows after exhausting attempts", async () => {
    const err = new Error("persistent");
    const fn = vi.fn().mockRejectedValue(err);
    const promise = withRetry(fn, { baseDelayMs: 10, maxAttempts: 2 });
    const expectation = expect(promise).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await expectation;
  });
});

describe("fetchHttpWithRetry", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries on transient HTTP statuses", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 429 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const promise = fetchHttpWithRetry("https://example.com", undefined, {
      baseDelayMs: 50,
      maxAttempts: 3,
    });
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-transient HTTP errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const res = await fetchHttpWithRetry("https://example.com");
    expect(res.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies the expected transient statuses", () => {
    expect(TRANSIENT_HTTP_STATUSES.has(429)).toBe(true);
    expect(TRANSIENT_HTTP_STATUSES.has(503)).toBe(true);
    expect(TRANSIENT_HTTP_STATUSES.has(404)).toBe(false);
  });

  it("HttpTransientError carries the status code", () => {
    expect(new HttpTransientError(429).status).toBe(429);
  });

  it("stops after three attempts and RETURNS the exhausted response (#1694)", async () => {
    // Never a throw the caller never handled: the provider's own `!res.ok` branch
    // stays the single place that decides what a 503 means for it.
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);

    const promise = fetchHttpWithRetry("https://example.com", undefined, {
      baseDelayMs: 10,
    });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("a network error still throws — there is no response to hand back", async () => {
    const boom = new Error("ECONNRESET");
    vi.mocked(fetch).mockRejectedValue(boom);

    const promise = fetchHttpWithRetry("https://example.com", undefined, {
      baseDelayMs: 10,
    });
    const expectation = expect(promise).rejects.toBe(boom);
    await vi.runAllTimersAsync();
    await expectation;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives each attempt its OWN deadline (#1694)", async () => {
    // The bug this pins: a caller-built `AbortSignal.timeout()` was created once,
    // before the retries, so every attempt shared one budget — after a timeout the
    // retries fired against an already-aborted signal and died instantly. The
    // helper now builds the signal per attempt, so no two attempts share one.
    const signals: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      signals.push((init as RequestInit | undefined)?.signal);
      if (signals.length < 3) throw new Error("network blip");
      return { ok: true, status: 200 } as Response;
    });

    const promise = fetchHttpWithRetry("https://example.com", undefined, {
      baseDelayMs: 10,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(3);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("respects a signal the caller owns instead of imposing its own", async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await fetchHttpWithRetry("https://example.com", { signal: controller.signal });

    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("shares one timeout constant instead of a literal per call-site", () => {
    expect(PRICING_FETCH_TIMEOUT_MS).toBe(8_000);
  });

  it("honors a per-call timeout override", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await fetchHttpWithRetry("https://example.com", undefined, { timeoutMs: 15_000 });

    expect(spy).toHaveBeenCalledWith(15_000);
    spy.mockRestore();
  });

  it("can be told NOT to retry a rate limit (#1694)", async () => {
    // CoinGecko's public tier answers 429 within a window that a 200/400ms
    // backoff never outlives, so three attempts just spend three requests and
    // dig the limit deeper. A caller that degrades cheaply opts out.
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);

    const res = await fetchHttpWithRetry("https://example.com", undefined, {
      retryStatuses: TRANSIENT_HTTP_STATUSES_EXCEPT_RATE_LIMIT,
    });

    expect(res.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("the non-rate-limit set still retries server errors", async () => {
    expect(TRANSIENT_HTTP_STATUSES_EXCEPT_RATE_LIMIT.has(429)).toBe(false);
    expect(TRANSIENT_HTTP_STATUSES_EXCEPT_RATE_LIMIT.has(503)).toBe(true);
    expect(TRANSIENT_HTTP_STATUSES_EXCEPT_RATE_LIMIT.has(408)).toBe(true);
  });

  it("uses an injected fetch when the caller publishes one", async () => {
    const injected = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

    await fetchHttpWithRetry("https://example.com", undefined, {
      fetchImpl: injected as unknown as typeof fetch,
    });

    expect(injected).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

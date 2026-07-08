import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchHttpWithRetry,
  HttpTransientError,
  TRANSIENT_HTTP_STATUSES,
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
});

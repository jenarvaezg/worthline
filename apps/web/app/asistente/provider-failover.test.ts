import { APICallError, LoadAPIKeyError } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  classifyPreOutputProviderError,
  streamWithProviderFailover,
} from "./provider-failover";

interface TestPart {
  type: string;
  error?: unknown;
  text?: string;
}

const PROVIDERS = [
  { provider: "google", modelId: "gemini" },
  { provider: "cerebras", modelId: "gpt-oss" },
] as const;

function apiError(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: "https://provider.invalid/chat",
    requestBodyValues: { secretFinancialPrompt: "must not be logged" },
    statusCode,
    responseBody: JSON.stringify({ error: { message } }),
  });
}

function controlledStream(parts: TestPart[]): ReadableStream<TestPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function streamThatThrowsAfterStart(error: unknown): ReadableStream<TestPart> {
  let pulled = false;
  return new ReadableStream({
    pull(controller) {
      if (!pulled) {
        pulled = true;
        controller.enqueue({ type: "start" });
        return;
      }
      controller.error(error);
    },
  });
}

function streamWithRejectingCancel(parts: TestPart[]): ReadableStream<TestPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
    },
    cancel() {
      throw new Error("cancel failed");
    },
  });
}

async function partsOf(stream: ReadableStream<TestPart>): Promise<TestPart[]> {
  const parts: TestPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    parts.push(result.value);
  }
  return parts;
}

describe("classifyPreOutputProviderError", () => {
  it.each([
    [apiError(429, "quota exhausted"), "quota_exhausted"],
    [
      apiError(429, "request too large for model on tokens per minute"),
      "request_too_large",
    ],
    [apiError(503, "upstream unavailable"), "provider_unavailable"],
    [apiError(401, "invalid API key"), "invalid_credential"],
    [new LoadAPIKeyError({ message: "API key is missing" }), "invalid_credential"],
  ])("classifies a failover-safe rejection", (error, expected) => {
    expect(classifyPreOutputProviderError(error)).toBe(expected);
  });

  it("does not fail over arbitrary request errors", () => {
    expect(
      classifyPreOutputProviderError(apiError(400, "invalid tool schema")),
    ).toBeNull();
  });
});

describe("streamWithProviderFailover", () => {
  it.each([
    [apiError(429, "quota exhausted"), "quota_exhausted"],
    [apiError(429, "request too large for model"), "request_too_large"],
    [apiError(502, "bad gateway"), "provider_unavailable"],
    [apiError(403, "credential rejected"), "invalid_credential"],
  ])("continues after a pre-output %s rejection", async (error, classification) => {
    const startStream = vi
      .fn()
      .mockReturnValueOnce(
        controlledStream([
          { type: "start" },
          { type: "start-step" },
          { type: "error", error },
        ]),
      )
      .mockReturnValueOnce(
        controlledStream([
          { type: "start" },
          { type: "start-step" },
          { type: "text-delta", text: "rescatado" },
        ]),
      );
    const log = vi.fn();

    const selected = await streamWithProviderFailover({
      providers: PROVIDERS,
      startStream,
      log,
    });

    expect(selected?.provider).toEqual(PROVIDERS[1]);
    expect(await partsOf(selected!.stream)).toEqual([
      { type: "start" },
      { type: "start-step" },
      { type: "text-delta", text: "rescatado" },
    ]);
    expect(startStream).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "assistant_provider_rejected",
        provider: "google",
        classification,
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "assistant_provider_selected",
        provider: "cerebras",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("secretFinancialPrompt");
  });

  it("returns null after every provider rejects before output", async () => {
    const startStream = vi.fn((_provider: (typeof PROVIDERS)[number]) =>
      controlledStream([
        { type: "start" },
        { type: "error", error: apiError(503, "unavailable") },
      ]),
    );

    const selected = await streamWithProviderFailover({
      providers: PROVIDERS,
      startStream,
      log: vi.fn(),
    });

    expect(selected).toBeNull();
    expect(startStream).toHaveBeenCalledTimes(2);
  });

  it("fails over when the rejection is thrown while probing the provider stream", async () => {
    const startStream = vi
      .fn()
      .mockReturnValueOnce(
        streamThatThrowsAfterStart(apiError(503, "stream setup failed")),
      )
      .mockReturnValueOnce(
        controlledStream([{ type: "start" }, { type: "text-delta", text: "ok" }]),
      );

    const selected = await streamWithProviderFailover({
      providers: PROVIDERS,
      startStream,
      log: vi.fn(),
    });

    expect(selected?.provider).toEqual(PROVIDERS[1]);
    expect(await partsOf(selected!.stream)).toEqual([
      { type: "start" },
      { type: "text-delta", text: "ok" },
    ]);
  });

  it("keeps probing past text-start because no token has been emitted", async () => {
    const startStream = vi
      .fn()
      .mockReturnValueOnce(
        controlledStream([
          { type: "start" },
          { type: "text-start" },
          { type: "error", error: apiError(429, "quota exhausted") },
        ]),
      )
      .mockReturnValueOnce(
        controlledStream([{ type: "start" }, { type: "text-delta", text: "ok" }]),
      );

    const selected = await streamWithProviderFailover({
      providers: PROVIDERS,
      startStream,
      log: vi.fn(),
    });

    expect(selected?.provider).toEqual(PROVIDERS[1]);
    expect(startStream).toHaveBeenCalledTimes(2);
  });

  it("continues failover when best-effort cancellation rejects", async () => {
    const startStream = vi
      .fn()
      .mockReturnValueOnce(
        streamWithRejectingCancel([
          { type: "start" },
          { type: "error", error: apiError(503, "unavailable") },
        ]),
      )
      .mockReturnValueOnce(
        controlledStream([{ type: "start" }, { type: "text-delta", text: "ok" }]),
      );

    const selected = await streamWithProviderFailover({
      providers: PROVIDERS,
      startStream,
      log: vi.fn(),
    });

    expect(selected?.provider).toEqual(PROVIDERS[1]);
  });

  it("replaces an unclassified probing exception with a generic stream error", async () => {
    const original = apiError(400, "bad request with private detail");
    const startStream = vi.fn(() => streamThatThrowsAfterStart(original));

    const selected = await streamWithProviderFailover({
      providers: PROVIDERS,
      startStream,
      log: vi.fn(),
    });
    const parts = await partsOf(selected!.stream);

    expect(selected?.provider).toEqual(PROVIDERS[0]);
    expect(startStream).toHaveBeenCalledTimes(1);
    expect(parts.at(-1)).toMatchObject({ type: "error" });
    expect(parts.at(-1)?.error).not.toBe(original);
    expect(JSON.stringify(parts)).not.toContain("secretFinancialPrompt");
    expect(JSON.stringify(parts)).not.toContain("private detail");
  });

  it("commits after real output and leaves a later error in the selected stream", async () => {
    const lateError = apiError(503, "failed after output");
    const startStream = vi.fn(() =>
      controlledStream([
        { type: "start" },
        { type: "text-delta", text: "visible" },
        { type: "error", error: lateError },
      ]),
    );

    const selected = await streamWithProviderFailover({
      providers: PROVIDERS,
      startStream,
      log: vi.fn(),
    });

    expect(selected?.provider).toEqual(PROVIDERS[0]);
    expect(await partsOf(selected!.stream)).toEqual([
      { type: "start" },
      { type: "text-delta", text: "visible" },
      { type: "error", error: lateError },
    ]);
    expect(startStream).toHaveBeenCalledTimes(1);
  });
});

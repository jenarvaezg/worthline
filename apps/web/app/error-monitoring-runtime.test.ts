import { afterEach, describe, expect, test, vi } from "vitest";

const { initMock, captureRequestErrorMock } = vi.hoisted(() => ({
  captureRequestErrorMock: vi.fn(),
  initMock: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureRequestError: captureRequestErrorMock,
  init: initMock,
}));

import { reportRequestError, startErrorMonitoring } from "./error-monitoring-runtime";

const DSN = "https://publickey@o0.ingest.example.invalid/0";

describe("startErrorMonitoring (#1175)", () => {
  afterEach(() => {
    initMock.mockReset();
  });

  test("initializes the SDK with the errors-only options", () => {
    startErrorMonitoring(DSN, {});
    expect(initMock).toHaveBeenCalledOnce();
    const options = initMock.mock.calls[0]![0];
    expect(options.dsn).toBe(DSN);
    expect(options).not.toHaveProperty("tracesSampleRate");
  });

  test("an inherited SENTRY_TRACES_SAMPLE_RATE cannot switch tracing on", () => {
    // The SDK falls back to this env var when the option is absent — which it
    // always is here — so it is dropped before init rather than obeyed.
    const env: Record<string, string | undefined> = { SENTRY_TRACES_SAMPLE_RATE: "1" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      startErrorMonitoring(DSN, env);
      expect(env).not.toHaveProperty("SENTRY_TRACES_SAMPLE_RATE");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("reportRequestError (#1175)", () => {
  test("hands the Next.js error to the SDK's request-error capture", () => {
    const error = new Error("boom");
    const request = { headers: {}, method: "GET", path: "/patrimonio" };
    const context = {
      renderSource: "react-server-components",
      renderType: "dynamic",
      revalidateReason: undefined,
      routePath: "/(workspace)/patrimonio",
      routeType: "render",
      routerKind: "App Router",
    } as const;
    reportRequestError(error, request, context);
    expect(captureRequestErrorMock).toHaveBeenCalledWith(error, request, context);
  });
});

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
    vi.unstubAllEnvs();
  });

  test("initializes the SDK with the errors-only options", () => {
    startErrorMonitoring(DSN);
    expect(initMock).toHaveBeenCalledOnce();
    const options = initMock.mock.calls[0]![0];
    expect(options.dsn).toBe(DSN);
    expect(options).not.toHaveProperty("tracesSampleRate");
  });

  test("removes an inherited SENTRY_TRACES_SAMPLE_RATE from process.env before init", () => {
    // The SDK reads this from process.env whenever the option is absent — which
    // it always is here — so it is dropped where the SDK would read it.
    vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let seenAtInit: string | undefined = "not called";
    initMock.mockImplementation(() => {
      seenAtInit = process.env.SENTRY_TRACES_SAMPLE_RATE;
    });
    try {
      startErrorMonitoring(DSN);
      expect(seenAtInit).toBeUndefined();
      expect(process.env).not.toHaveProperty("SENTRY_TRACES_SAMPLE_RATE");
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

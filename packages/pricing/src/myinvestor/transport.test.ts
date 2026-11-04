import { describe, expect, it, vi } from "vitest";

import { createRelayTransport } from "./transport";

const CONFIG = {
  url: "https://relay.example.workers.dev/",
  secret: "s".repeat(40),
};

function fakeFetch(response: Response | Error) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe("the relay transport", () => {
  it("sends every call to the relay with the shared secret and the MyInvestor target", async () => {
    const fetchImpl = fakeFetch(
      new Response('{"ok":1}', {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const transport = createRelayTransport(CONFIG, { fetchImpl });

    const outcome = await transport.send({
      method: "POST",
      path: "/login/api/v2/auth/token",
      query: { a: "1", b: "x y" },
      headers: { "x-device-id": "device-sintetico" },
      body: { customerId: "c", password: "p" },
    });

    expect(outcome).toEqual({
      kind: "response",
      status: 201,
      contentType: "application/json",
      text: '{"ok":1}',
      relayError: null,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(CONFIG.url);
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe("POST");
    expect(headers.get("x-relay-secret")).toBe(CONFIG.secret);
    expect(headers.get("x-relay-target")).toBe(
      "https://api.myinvestor.es/login/api/v2/auth/token?a=1&b=x+y",
    );
    expect(headers.get("x-device-id")).toBe("device-sintetico");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/Mozilla/);
    expect(headers.get("x-myinvestor-app")).toMatch(/platform=web/);
    expect(init?.body).toBe('{"customerId":"c","password":"p"}');
    expect(init?.redirect).toBe("manual");
  });

  it("sends a GET without a body nor a content type", async () => {
    const fetchImpl = fakeFetch(new Response("[]", { status: 200 }));
    const transport = createRelayTransport(CONFIG, { fetchImpl });

    await transport.send({ method: "GET", path: "/cperf-server/api/v2/portfolios" });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("content-type")).toBeNull();
    expect(new Headers(init?.headers).get("x-relay-target")).toBe(
      "https://api.myinvestor.es/cperf-server/api/v2/portfolios",
    );
  });

  it("reports the relay's own refusals apart from MyInvestor's answers", async () => {
    const fetchImpl = fakeFetch(
      new Response("", { status: 401, headers: { "x-relay-error": "unauthorized" } }),
    );

    const outcome = await createRelayTransport(CONFIG, { fetchImpl }).send({
      method: "GET",
      path: "/x",
    });

    expect(outcome).toMatchObject({
      kind: "response",
      status: 401,
      relayError: "unauthorized",
    });
  });

  it("turns a network failure or a timeout into an outcome, never a throw", async () => {
    const network = createRelayTransport(CONFIG, {
      fetchImpl: fakeFetch(new TypeError("fetch failed")),
    });
    const timeout = createRelayTransport(CONFIG, {
      fetchImpl: fakeFetch(new DOMException("timed out", "TimeoutError")),
    });

    expect(await network.send({ method: "GET", path: "/x" })).toEqual({
      kind: "unreachable",
      reason: "network",
    });
    expect(await timeout.send({ method: "GET", path: "/x" })).toEqual({
      kind: "unreachable",
      reason: "timeout",
    });
  });

  it("refuses a path that could leave api.myinvestor.es", async () => {
    const fetchImpl = fakeFetch(new Response(""));
    const transport = createRelayTransport(CONFIG, { fetchImpl });

    await expect(
      transport.send({ method: "GET", path: "//evil.example/x" }),
    ).rejects.toThrow(RangeError);
    await expect(transport.send({ method: "GET", path: "x" })).rejects.toThrow(
      RangeError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

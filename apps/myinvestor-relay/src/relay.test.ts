import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRelay, type RelayEnv } from "./relay";

const SECRET = "r".repeat(40);
const ENV: RelayEnv = { RELAY_SECRET: SECRET };
const TARGET = "https://api.myinvestor.es/login/api/v2/auth/token";

function upstream(response: Response | Error = new Response("{}", { status: 200 })) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
}

function relayRequest(
  options: {
    method?: string;
    secret?: string | null;
    target?: string | null;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.secret !== null) headers.set("x-relay-secret", options.secret ?? SECRET);
  if (options.target !== null) headers.set("x-relay-target", options.target ?? TARGET);
  return new Request("https://relay.example.workers.dev/", {
    method: options.method ?? "POST",
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the MyInvestor relay", () => {
  it("answers 401 without the secret, and never calls MyInvestor", async () => {
    const fetchImpl = upstream();

    const response = await handleRelay(relayRequest({ secret: null }), ENV, fetchImpl);

    expect(response.status).toBe(401);
    expect(response.headers.get("x-relay-error")).toBe("unauthorized");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers 401 with a wrong secret, of any length", async () => {
    const fetchImpl = upstream();

    for (const secret of ["x", `${SECRET}x`, "s".repeat(40)]) {
      const response = await handleRelay(relayRequest({ secret }), ENV, fetchImpl);
      expect(response.status).toBe(401);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the Worker has no secret configured", async () => {
    const fetchImpl = upstream();

    const response = await handleRelay(
      relayRequest({ secret: "" }),
      { RELAY_SECRET: "" },
      fetchImpl,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-relay-error")).toBe("misconfigured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects any target that is not https://api.myinvestor.es", async () => {
    const fetchImpl = upstream();
    const targets = [
      "https://evil.example/login/api/v2/auth/token",
      "https://api.myinvestor.es.evil.example/x",
      "https://evil.example/https://api.myinvestor.es/x",
      "http://api.myinvestor.es/x",
      "https://api.myinvestor.es:8443/x",
      "https://user:pass@api.myinvestor.es/x",
      "https://newapp.myinvestor.es/x",
      "not a url",
    ];

    for (const target of targets) {
      const response = await handleRelay(relayRequest({ target }), ENV, fetchImpl);
      expect(response.status, target).toBe(403);
      expect(response.headers.get("x-relay-error")).toBe("forbidden_target");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for the target when it is missing", async () => {
    const response = await handleRelay(relayRequest({ target: null }), ENV, upstream());

    expect(response.status).toBe(400);
    expect(response.headers.get("x-relay-error")).toBe("missing_target");
  });

  it("only relays GET and POST", async () => {
    const fetchImpl = upstream();

    const response = await handleRelay(
      relayRequest({ method: "DELETE" }),
      ENV,
      fetchImpl,
    );

    expect(response.status).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("relays a POST only to the sign-in routes the client uses", async () => {
    const allowed = [
      TARGET,
      "https://api.myinvestor.es/login/api/v1/auth/token/refresh",
      "https://api.myinvestor.es/signature/api/v3/public/signature/sig-req-sintetico-0001?method=OTP_SMS",
      "https://api.myinvestor.es/signature/api/v3/public/signature/sig-req-sintetico-0001/validate/sig-sintetico-0002",
    ];

    for (const target of allowed) {
      const fetchImpl = upstream();
      const response = await handleRelay(relayRequest({ target }), ENV, fetchImpl);
      expect(response.status, target).toBe(200);
      expect(fetchImpl, target).toHaveBeenCalledOnce();
    }
  });

  it("refuses a POST to any other route, and never calls MyInvestor", async () => {
    const fetchImpl = upstream();
    const targets = [
      "https://api.myinvestor.es/cperf-server/api/v2/cash-accounts/self",
      "https://api.myinvestor.es/broker/v2/stock-orders",
      "https://api.myinvestor.es/login/api/v2/auth/token/extra",
      "https://api.myinvestor.es/signature/api/v3/public/signature/",
      "https://api.myinvestor.es/signature/api/v3/public/signature/a/validate",
      "https://api.myinvestor.es/signature/api/v3/public/signature/a/cancel/b",
      "https://api.myinvestor.es/signature/api/v3/public/signature/a/validate/b/c",
    ];

    for (const target of targets) {
      const response = await handleRelay(relayRequest({ target }), ENV, fetchImpl);
      expect(response.status, target).toBe(403);
      expect(response.headers.get("x-relay-error"), target).toBe("forbidden_route");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still relays a GET to any route of api.myinvestor.es", async () => {
    const fetchImpl = upstream();
    const target = "https://api.myinvestor.es/cperf-server/api/v2/cash-accounts/self";

    const response = await handleRelay(
      relayRequest({ method: "GET", target }),
      ENV,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("passes the body intact both ways, with MyInvestor's status", async () => {
    const sent = '{"customerId":"00000000A","password":"contraseña ñ €"}';
    const answer =
      '{"payload":{"data":{"errCode":"UNAUTHORIZED"}},"status":{"code":"BAD_REQUEST"}}';
    const fetchImpl = upstream(
      new Response(answer, {
        status: 401,
        headers: {
          "content-type": "application/json;charset=UTF-8",
          "set-cookie": "visid_incap=1",
        },
      }),
    );

    const response = await handleRelay(relayRequest({ body: sent }), ENV, fetchImpl);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe(answer);
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(response.headers.get("x-relay-error")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(TARGET);
    expect(init?.method).toBe("POST");
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(sent);
    expect(init?.redirect).toBe("manual");
  });

  it("keeps the query of the target", async () => {
    const fetchImpl = upstream();
    const target =
      "https://api.myinvestor.es/cperf-server/api/v2/pension-accounts/1/orders?dateFrom=20000101&dateTo=20250620";

    await handleRelay(relayRequest({ method: "GET", target }), ENV, fetchImpl);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(target);
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it("forwards MyInvestor's headers and never its own secret or target", async () => {
    const fetchImpl = upstream();

    await handleRelay(
      relayRequest({
        method: "GET",
        headers: {
          authorization: "Bearer access-sintetico",
          "x-device-id": "device-sintetico",
          "x-signature-id": "sig-req-sintetico-0001",
          "x-myinvestor-app": "version=3.134.0,platform=web",
          "user-agent": "Mozilla/5.0",
          "cf-connecting-ip": "203.0.113.1",
          "x-forwarded-for": "203.0.113.1",
        },
      }),
      ENV,
      fetchImpl,
    );

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-sintetico");
    expect(headers.get("x-device-id")).toBe("device-sintetico");
    expect(headers.get("x-signature-id")).toBe("sig-req-sintetico-0001");
    expect(headers.get("x-myinvestor-app")).toBe("version=3.134.0,platform=web");
    expect(headers.get("user-agent")).toBe("Mozilla/5.0");
    expect(headers.get("x-relay-secret")).toBeNull();
    expect(headers.get("x-relay-target")).toBeNull();
    expect(headers.get("cf-connecting-ip")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
  });

  it("answers 502 upstream_unreachable when MyInvestor does not answer", async () => {
    const response = await handleRelay(
      relayRequest(),
      ENV,
      upstream(new TypeError("fetch failed")),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("x-relay-error")).toBe("upstream_unreachable");
  });

  it("logs nothing: no body, no header, no error", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );

    await handleRelay(relayRequest({ body: '{"password":"p"}' }), ENV, upstream());
    await handleRelay(relayRequest({ secret: "x" }), ENV, upstream());
    await handleRelay(relayRequest(), ENV, upstream(new TypeError("fetch failed")));

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

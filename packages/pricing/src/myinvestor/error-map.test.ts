/**
 * The error map of ADR 0114 (decision 7) against recorded responses of each kind.
 * The session bodies come from the S1 synthetic fixtures; the rejections that S1 has
 * no file for are written here with the shapes the prototype of #1866 logged
 * (`403 SECURITY_001 «Captcha required»`, the Imperva page).
 */
import { describe, expect, it } from "vitest";

import { createMyInvestorClient, type MyInvestorClientOptions } from "./client";
import type { MyInvestorError } from "./errors";
import {
  fixtureReply,
  type RecordingTransport,
  recordingSleep,
  reply,
  scriptedTransport,
} from "./testing/fake-transport";
import type { TransportOutcome } from "./transport";

const CREDENTIALS = { customerId: "00000000A", password: "contraseña-sintetica" };
const TOKENS = { accessToken: "access-sintetico", refreshToken: "refresh-sintetico" };

const CAPTCHA_REQUIRED = JSON.stringify({
  status: { code: "SECURITY_001", message: "Captcha required" },
});
const UNKNOWN_ERR_CODE = JSON.stringify({
  payload: { data: { errCode: "TOO_MANY_ATTEMPTS" } },
  status: { code: "BAD_REQUEST" },
});
const PASSWORD_CHANGE = JSON.stringify({
  payload: { data: { errCode: "UPDATE_PASSWORD_REQUIRED" } },
  status: { code: "BAD_REQUEST" },
});
const IMPERVA_PAGE =
  '<html><head><META NAME="robots"></head><body><script src="/_Incapsula_Resource?SWJIYLWA=1"></script></body></html>';
const UNREACHABLE: TransportOutcome = { kind: "unreachable", reason: "timeout" };

function setup(
  script: readonly TransportOutcome[],
  options: Partial<MyInvestorClientOptions> = {},
): {
  client: ReturnType<typeof createMyInvestorClient>;
  transport: RecordingTransport;
  waits: number[];
} {
  const transport = scriptedTransport(script);
  const { waits, sleep } = recordingSleep();
  const client = createMyInvestorClient({
    transport,
    deviceId: "device-sintetico",
    sleep,
    ...options,
  });
  return { client, transport, waits };
}

function errorOf(result: { ok: boolean; error?: MyInvestorError }): MyInvestorError {
  if (result.ok || !result.error) throw new Error("Se esperaba un error");
  return result.error;
}

describe("login", () => {
  it("returns the tokens of a known device", async () => {
    const { client, transport } = setup([fixtureReply("synthetic/login-tokens.json")]);

    const result = await client.login(CREDENTIALS);

    expect(result).toMatchObject({ ok: true, value: { kind: "tokens" } });
    expect(transport.requests[0]).toMatchObject({
      method: "POST",
      path: "/login/api/v2/auth/token",
      headers: { "x-device-id": "device-sintetico" },
      body: { customerId: CREDENTIALS.customerId, password: CREDENTIALS.password },
    });
  });

  it("hands back the signature request when the device is new", async () => {
    const { client } = setup([
      fixtureReply("synthetic/login-signature-pending.json", 202),
    ]);

    const result = await client.login(CREDENTIALS);

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "signature",
        challenge: { requestId: "sig-req-sintetico-0001", methods: ["OTP_SMS"] },
      },
    });
  });

  it("repeats the login signed, with x-signature-id, once the SMS is validated", async () => {
    const { client, transport } = setup([fixtureReply("synthetic/login-tokens.json")]);

    const result = await client.signedLogin(CREDENTIALS, "sig-req-sintetico-0001");

    expect(result.ok).toBe(true);
    expect(transport.requests[0]?.headers).toMatchObject({
      "x-device-id": "device-sintetico",
      "x-signature-id": "sig-req-sintetico-0001",
    });
  });
});

describe("the error map (ADR 0114, decision 7)", () => {
  it("password_rejected: UNAUTHORIZED, never retried", async () => {
    const { client, transport } = setup([
      fixtureReply("synthetic/login-rejected-unauthorized.json", 401),
    ]);

    const error = errorOf(await client.login(CREDENTIALS));

    expect(error).toEqual({
      kind: "password_rejected",
      step: "login",
      httpStatus: 401,
      code: "UNAUTHORIZED",
      attempts: 1,
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("password_rejected: MyInvestor asks to change the password", async () => {
    const { client } = setup([reply(400, PASSWORD_CHANGE)]);

    const error = errorOf(await client.login(CREDENTIALS));

    expect(error).toMatchObject({
      kind: "password_rejected",
      code: "UPDATE_PASSWORD_REQUIRED",
    });
  });

  it("rejected_no_reason: 403 SECURITY_001 «Captcha required» keeps the password", async () => {
    const { client, transport } = setup([reply(403, CAPTCHA_REQUIRED)]);

    const error = errorOf(await client.login(CREDENTIALS));

    expect(error).toEqual({
      kind: "rejected_no_reason",
      step: "login",
      httpStatus: 403,
      code: "SECURITY_001",
      attempts: 1,
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("rejected_no_reason: an errCode the map does not know", async () => {
    const { client } = setup([reply(400, UNKNOWN_ERR_CODE)]);

    expect(errorOf(await client.login(CREDENTIALS))).toMatchObject({
      kind: "rejected_no_reason",
      code: "TOO_MANY_ATTEMPTS",
    });
  });

  it("network_or_waf: the Imperva page is retried three times with growing waits", async () => {
    const page = reply(403, IMPERVA_PAGE, { contentType: "text/html" });
    const { client, transport, waits } = setup([page, page, page, page]);

    const error = errorOf(await client.login(CREDENTIALS));

    expect(error).toEqual({
      kind: "network_or_waf",
      step: "login",
      httpStatus: 403,
      code: "waf",
      attempts: 4,
    });
    expect(transport.requests).toHaveLength(4);
    expect(waits).toHaveLength(3);
    expect(waits[0]).toBeLessThan(waits[1] ?? 0);
    expect(waits[1]).toBeLessThan(waits[2] ?? 0);
  });

  it("network_or_waf: a blip that clears inside the same call is not an error", async () => {
    const { client, waits } = setup([
      UNREACHABLE,
      reply(503, ""),
      fixtureReply("synthetic/login-tokens.json"),
    ]);

    const result = await client.login(CREDENTIALS);

    expect(result).toMatchObject({ ok: true, value: { kind: "tokens" } });
    expect(waits).toHaveLength(2);
  });

  it("network_or_waf: the network never answers", async () => {
    const { client } = setup([UNREACHABLE, UNREACHABLE, UNREACHABLE, UNREACHABLE]);

    expect(errorOf(await client.login(CREDENTIALS))).toEqual({
      kind: "network_or_waf",
      step: "login",
      httpStatus: null,
      code: "timeout",
      attempts: 4,
    });
  });

  it("network_or_waf: the relay could not reach MyInvestor", async () => {
    const down = reply(502, "", { relayError: "upstream_unreachable" });
    const { client } = setup([down, down, down, down]);

    expect(errorOf(await client.login(CREDENTIALS))).toMatchObject({
      kind: "network_or_waf",
      code: "upstream_unreachable",
      attempts: 4,
    });
  });

  it("network_or_waf: the number of retries and their waits are the caller's", async () => {
    const page = reply(429, IMPERVA_PAGE, { contentType: "text/html" });
    const { client, waits } = setup([page, page], { retryDelaysMs: [5] });

    expect(errorOf(await client.login(CREDENTIALS))).toMatchObject({ attempts: 2 });
    expect(waits).toEqual([5]);
  });

  it("sms_required: the device_id expired, so the unattended login asks for a signature", async () => {
    const { client } = setup([
      fixtureReply("synthetic/login-signature-pending.json", 202),
    ]);

    expect(errorOf(await client.loginWithKnownDevice(CREDENTIALS))).toEqual({
      kind: "sms_required",
      step: "login",
      httpStatus: 202,
      code: null,
      attempts: 1,
    });
  });

  it("sms_required: a read that asks for a signature", async () => {
    const { client } = setup([
      fixtureReply("synthetic/login-signature-pending.json", 202),
    ]);

    expect(errorOf(await client.reader(TOKENS).cashAccounts())).toMatchObject({
      kind: "sms_required",
      step: "cash",
      httpStatus: 202,
    });
  });

  it("relay_rejected: the relay refuses the secret, and that is never retried", async () => {
    const { client, transport } = setup([reply(401, "", { relayError: "unauthorized" })]);

    expect(errorOf(await client.login(CREDENTIALS))).toEqual({
      kind: "relay_rejected",
      step: "login",
      httpStatus: 401,
      code: "unauthorized",
      attempts: 1,
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("unexpected_response: a body that does not fit is named, never echoed", async () => {
    const odd = JSON.stringify({ payload: { data: [{ accountId: "1", secret: "x" }] } });
    const { client } = setup([reply(200, odd)]);

    const error = errorOf(await client.reader(TOKENS).cashAccounts());

    expect(error).toMatchObject({
      kind: "unexpected_response",
      step: "cash",
      httpStatus: 200,
    });
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("unexpected_response: a code no more specific than its status is kept out", async () => {
    const { client } = setup([reply(404, "not json at all")]);

    expect(errorOf(await client.login(CREDENTIALS))).toMatchObject({
      kind: "unexpected_response",
      httpStatus: 404,
      code: null,
    });
  });
});

describe("refresh", () => {
  it("accepts any 2xx: MyInvestor answers 201", async () => {
    const { client, transport } = setup([
      fixtureReply("synthetic/refresh-tokens.json", 201),
    ]);

    const result = await client.refresh("refresh-sintetico");

    expect(result).toMatchObject({ ok: true });
    expect(transport.requests[0]).toMatchObject({
      method: "POST",
      path: "/login/api/v1/auth/token/refresh",
      body: { refreshToken: "refresh-sintetico" },
    });
    expect(transport.requests[0]?.headers).not.toHaveProperty("authorization");
  });

  it("a rejected refresh means the session is over", async () => {
    const { client } = setup([fixtureReply("synthetic/refresh-rejected.json", 400)]);

    expect(errorOf(await client.refresh("refresh-sintetico"))).toMatchObject({
      kind: "session_expired",
      step: "refresh",
    });
  });

  it("a read renews an expired access token once and repeats itself", async () => {
    const { client, transport } = setup([
      reply(401, ""),
      fixtureReply("synthetic/refresh-tokens.json", 201),
      fixtureReply("synthetic/cash-accounts-representative.json"),
    ]);
    const reader = client.reader(TOKENS);

    const result = await reader.cashAccounts();

    expect(result.ok).toBe(true);
    expect(transport.requests.map((request) => request.path)).toEqual([
      "/cperf-server/api/v2/cash-accounts/self",
      "/login/api/v1/auth/token/refresh",
      "/cperf-server/api/v2/cash-accounts/self",
    ]);
    expect(transport.requests[2]?.headers?.authorization).not.toBe(
      `Bearer ${TOKENS.accessToken}`,
    );
    expect(reader.tokens().accessToken).not.toBe(TOKENS.accessToken);
  });

  it("a second 401 after renewing is session_expired, not a loop", async () => {
    const { client, transport } = setup([
      reply(401, ""),
      fixtureReply("synthetic/refresh-tokens.json", 201),
      reply(401, ""),
    ]);

    expect(errorOf(await client.reader(TOKENS).cashAccounts())).toMatchObject({
      kind: "session_expired",
      step: "cash",
    });
    expect(transport.requests).toHaveLength(3);
  });

  it("without a refresh token an expired access is session_expired", async () => {
    const { client } = setup([reply(401, "")]);

    expect(
      errorOf(
        await client
          .reader({ accessToken: "access-sintetico", refreshToken: null })
          .cashAccounts(),
      ),
    ).toMatchObject({ kind: "session_expired" });
  });
});

describe("the two-step SMS", () => {
  const CHALLENGE = { requestId: "sig-req-sintetico-0001", methods: ["OTP_SMS"] };

  it("starts the SMS and hands back what validates the code", async () => {
    const { client, transport } = setup([
      fixtureReply("synthetic/signature-start-sms.json"),
    ]);

    const result = await client.startCode(CHALLENGE);

    expect(result).toEqual({
      ok: true,
      value: {
        signatureId: "sig-sintetico-0001",
        method: "OTP_SMS",
        destination: "+34 6** *** *00",
      },
    });
    expect(transport.requests[0]).toMatchObject({
      method: "POST",
      path: "/signature/api/v3/public/signature/sig-req-sintetico-0001",
      query: { method: "OTP_SMS" },
    });
  });

  it("never sends the SMS twice: a failed start is not retried", async () => {
    const page = reply(503, IMPERVA_PAGE, { contentType: "text/html" });
    const { client, transport } = setup([page]);

    expect(errorOf(await client.startCode(CHALLENGE))).toMatchObject({
      kind: "network_or_waf",
      step: "sms",
      attempts: 1,
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("refuses a challenge with no code method", async () => {
    const { client, transport } = setup([]);

    expect(
      errorOf(await client.startCode({ requestId: "r", methods: ["PUSH_APPROVAL"] })),
    ).toMatchObject({ kind: "unexpected_response", step: "sms", code: "no_code_method" });
    expect(transport.requests).toHaveLength(0);
  });

  it("validates the code", async () => {
    const { client, transport } = setup([
      fixtureReply("synthetic/signature-validate-complete.json"),
    ]);

    const result = await client.submitCode({
      requestId: "sig-req-sintetico-0001",
      signatureId: "sig-sintetico-0001",
      code: " 123456 ",
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(transport.requests[0]).toMatchObject({
      path: "/signature/api/v3/public/signature/sig-req-sintetico-0001/validate/sig-sintetico-0001",
      body: { code: "123456" },
    });
  });

  it("code_rejected: a wrong code", async () => {
    const { client } = setup([
      reply(422, JSON.stringify({ status: { code: "BAD_REQUEST" } })),
    ]);

    expect(
      errorOf(
        await client.submitCode({ requestId: "r", signatureId: "s", code: "000000" }),
      ),
    ).toMatchObject({ kind: "code_rejected", step: "sms", httpStatus: 422 });
  });
});

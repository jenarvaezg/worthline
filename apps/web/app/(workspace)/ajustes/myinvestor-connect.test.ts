/**
 * Connecting MyInvestor, step by step (#1879, ADR 0114). The client is a fake: the
 * two-step SMS has never run against the real API, and no test here may reach it.
 * The store is a real in-memory one, so what each step leaves in the database —
 * the pending step and `credentials_json` — is read back, not assumed.
 */
import { createInMemoryStore, type PersistenceTestStore } from "@worthline/db/testing";
import type {
  MyInvestorError,
  MyInvestorErrorKind,
  MyInvestorResult,
} from "@worthline/pricing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  forgetMyInvestorPassword,
  type MyInvestorConnectClient,
  type MyInvestorFlowDeps,
  saveMyInvestorPassword,
  startMyInvestorConnect,
  submitMyInvestorCode,
} from "./myinvestor-connect";
import {
  MYINVESTOR_ALREADY_CONNECTED,
  MYINVESTOR_CODE_REJECTED,
  MYINVESTOR_DEVICE_LAPSED,
  MYINVESTOR_LOGIN_ERRORS,
  MYINVESTOR_MAX_CODE_ATTEMPTS,
  MYINVESTOR_PENDING_EXPIRED,
  MYINVESTOR_SAVE_REJECTED,
  MYINVESTOR_TOO_MANY_CODES,
} from "./myinvestor-copy";
import { readMyInvestorPending } from "./myinvestor-credentials";

const NOW = "2026-11-04T12:00:00.000Z";
const TOKENS = { accessToken: "access", refreshToken: "refresh" };
const CHALLENGE = { methods: ["OTP_SMS"], requestId: "request-1" };

function ok<T>(value: T): MyInvestorResult<T> {
  return { ok: true, value };
}

function failure<T>(kind: MyInvestorErrorKind): MyInvestorResult<T> {
  const error: MyInvestorError = {
    attempts: 1,
    code: null,
    httpStatus: 401,
    kind,
    step: "login",
  };
  return { error, ok: false };
}

/** A client that answers as MyInvestor would for a device it does not know yet. */
function smsClient(): MyInvestorConnectClient {
  return {
    login: vi.fn(async () => ok({ challenge: CHALLENGE, kind: "signature" as const })),
    loginWithKnownDevice: vi.fn(async () => ok(TOKENS)),
    signedLogin: vi.fn(async () => ok(TOKENS)),
    startCode: vi.fn(async () =>
      ok({ destination: "+34 6** *** *00", method: "OTP_SMS", signatureId: "sig-1" }),
    ),
    submitCode: vi.fn(async () => ok(null)),
  };
}

/** A client for a device MyInvestor already trusts: tokens straight away. */
function knownDeviceClient(): MyInvestorConnectClient {
  return {
    ...smsClient(),
    login: vi.fn(async () => ok({ kind: "tokens" as const, tokens: TOKENS })),
  };
}

let store: PersistenceTestStore;

beforeEach(async () => {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Titular" }],
    mode: "individual",
  });
});

function deps(
  client: MyInvestorConnectClient,
  overrides: Partial<MyInvestorFlowDeps> = {},
): MyInvestorFlowDeps {
  return {
    acceptedBy: "titular@example.com",
    clientFor: () => client,
    newDeviceId: () => "device-1",
    now: NOW,
    store: store.connectedSources,
    ...overrides,
  };
}

const LOGIN = { customerId: "12345678A", password: "secret", save: false };

async function storedCredentials(): Promise<unknown> {
  const [source] = await store.connectedSources.listSources();
  return source ? JSON.parse(source.credentialsJson) : null;
}

describe("login without SMS (a device MyInvestor already trusts)", () => {
  test("without the box, the connection keeps only the device", async () => {
    const step = await startMyInvestorConnect(deps(knownDeviceClient()), LOGIN);

    expect(step).toEqual({ savedPassword: false, step: "connected" });
    const [source] = await store.connectedSources.listSources();
    expect(source).toMatchObject({ adapter: "myinvestor", assetId: null });
    expect(await storedCredentials()).toEqual({ deviceId: "device-1" });
  });

  test("with the box, it also keeps the username, the password and the acceptance", async () => {
    const step = await startMyInvestorConnect(deps(knownDeviceClient()), {
      ...LOGIN,
      save: true,
    });

    expect(step).toEqual({ savedPassword: true, step: "connected" });
    expect(await storedCredentials()).toEqual({
      acceptance: { acceptedAt: NOW, acceptedBy: "titular@example.com" },
      customerId: "12345678A",
      deviceId: "device-1",
      password: "secret",
    });
  });
});

describe("login with SMS", () => {
  test("the first step sends the code and keeps the pending step for five minutes", async () => {
    const client = smsClient();

    const step = await startMyInvestorConnect(deps(client), LOGIN);

    expect(step).toMatchObject({
      destination: "+34 6** *** *00",
      error: null,
      expiresAt: "2026-11-04T12:05:00.000Z",
      step: "sms",
    });
    expect(client.startCode).toHaveBeenCalledWith(CHALLENGE);
    // Nothing is connected yet: the row stays «Sin conectar» until the code.
    expect(await store.connectedSources.listSources()).toEqual([]);
    const pending = await store.connectedSources.readPendingLogin(
      step.step === "sms" ? step.pendingId : "",
    );
    // Without the box the pending step holds no credential at all.
    expect(readMyInvestorPending(pending!.payloadJson)).toEqual({
      deviceId: "device-1",
      requestId: "request-1",
      save: null,
      signatureId: "sig-1",
    });
  });

  test("the right code connects with the same device, and the pending step goes", async () => {
    const client = smsClient();
    const sms = await startMyInvestorConnect(deps(client), LOGIN);
    const pendingId = sms.step === "sms" ? sms.pendingId : "";

    const step = await submitMyInvestorCode(
      deps(client, { now: "2026-11-04T12:04:00.000Z" }),
      { code: "123456", pendingId },
    );

    expect(step).toEqual({ savedPassword: false, step: "connected" });
    expect(client.submitCode).toHaveBeenCalledWith({
      code: "123456",
      requestId: "request-1",
      signatureId: "sig-1",
    });
    expect(await storedCredentials()).toEqual({ deviceId: "device-1" });
    expect(await store.connectedSources.readPendingLogin(pendingId)).toBeNull();
  });

  test("with the box, the pending step keeps the credentials and the code finishes the login", async () => {
    const client = smsClient();
    const sms = await startMyInvestorConnect(deps(client), { ...LOGIN, save: true });
    const pendingId = sms.step === "sms" ? sms.pendingId : "";
    const pending = await store.connectedSources.readPendingLogin(pendingId);
    expect(readMyInvestorPending(pending!.payloadJson)?.save).toEqual({
      acceptedBy: "titular@example.com",
      customerId: "12345678A",
      password: "secret",
    });

    const step = await submitMyInvestorCode(
      deps(client, { now: "2026-11-04T12:02:00.000Z" }),
      { code: "123456", pendingId },
    );

    expect(step).toEqual({ savedPassword: true, step: "connected" });
    expect(client.signedLogin).toHaveBeenCalledWith(
      { customerId: "12345678A", password: "secret" },
      "request-1",
    );
    expect(await storedCredentials()).toEqual({
      acceptance: {
        acceptedAt: "2026-11-04T12:02:00.000Z",
        acceptedBy: "titular@example.com",
      },
      customerId: "12345678A",
      deviceId: "device-1",
      password: "secret",
    });
  });

  test("a pending step older than five minutes is refused and deleted", async () => {
    const client = smsClient();
    const sms = await startMyInvestorConnect(deps(client), LOGIN);
    const pendingId = sms.step === "sms" ? sms.pendingId : "";

    const step = await submitMyInvestorCode(
      deps(client, { now: "2026-11-04T12:05:00.001Z" }),
      { code: "123456", pendingId },
    );

    expect(step).toEqual({ error: MYINVESTOR_PENDING_EXPIRED, step: "credentials" });
    expect(client.submitCode).not.toHaveBeenCalled();
    expect(await store.connectedSources.readPendingLogin(pendingId)).toBeNull();
    expect(await store.connectedSources.listSources()).toEqual([]);
  });

  test("a pending step that no longer exists reads as expired", async () => {
    const step = await submitMyInvestorCode(deps(smsClient()), {
      code: "123456",
      pendingId: "gone",
    });

    expect(step).toEqual({ error: MYINVESTOR_PENDING_EXPIRED, step: "credentials" });
  });

  test("a wrong code stays on the SMS step and can be retried until it expires", async () => {
    const client = smsClient();
    const sms = await startMyInvestorConnect(deps(client), LOGIN);
    const pendingId = sms.step === "sms" ? sms.pendingId : "";
    vi.mocked(client.submitCode).mockResolvedValueOnce(failure("code_rejected"));

    const wrong = await submitMyInvestorCode(deps(client), { code: "000000", pendingId });

    expect(wrong).toEqual({
      destination: null,
      error: MYINVESTOR_CODE_REJECTED,
      expiresAt: "2026-11-04T12:05:00.000Z",
      pendingId,
      step: "sms",
    });
    expect(await store.connectedSources.listSources()).toEqual([]);

    const right = await submitMyInvestorCode(deps(client), { code: "123456", pendingId });
    expect(right).toEqual({ savedPassword: false, step: "connected" });
  });
});

describe("wrong codes are capped", () => {
  test(`after ${MYINVESTOR_MAX_CODE_ATTEMPTS} wrong codes the pending step is deleted and the login starts over`, async () => {
    const client = smsClient();
    const sms = await startMyInvestorConnect(deps(client), LOGIN);
    const pendingId = sms.step === "sms" ? sms.pendingId : "";
    vi.mocked(client.submitCode).mockResolvedValue(failure("code_rejected"));

    for (let attempt = 1; attempt < MYINVESTOR_MAX_CODE_ATTEMPTS; attempt += 1) {
      const step = await submitMyInvestorCode(deps(client), {
        code: "000000",
        pendingId,
      });
      expect(step).toMatchObject({ error: MYINVESTOR_CODE_REJECTED, step: "sms" });
    }
    const last = await submitMyInvestorCode(deps(client), { code: "000000", pendingId });

    expect(last).toEqual({ error: MYINVESTOR_TOO_MANY_CODES, step: "credentials" });
    expect(await store.connectedSources.readPendingLogin(pendingId)).toBeNull();
  });
});

describe("a refused login saves nothing", () => {
  test.each([
    ["password_rejected", MYINVESTOR_LOGIN_ERRORS.password_rejected],
    ["rejected_no_reason", MYINVESTOR_LOGIN_ERRORS.rejected_no_reason],
    ["network_or_waf", MYINVESTOR_LOGIN_ERRORS.network_or_waf],
    ["unexpected_response", MYINVESTOR_LOGIN_ERRORS.unexpected],
  ] as const)("%s", async (kind, message) => {
    const client = { ...smsClient(), login: vi.fn(async () => failure<never>(kind)) };

    const step = await startMyInvestorConnect(deps(client), { ...LOGIN, save: true });

    expect(step).toEqual({ error: message, step: "credentials" });
    expect(await store.connectedSources.listSources()).toEqual([]);
    expect(client.startCode).not.toHaveBeenCalled();
  });

  test("a second MyInvestor connection is refused before MyInvestor is asked", async () => {
    await startMyInvestorConnect(deps(knownDeviceClient()), LOGIN);
    const client = knownDeviceClient();

    const step = await startMyInvestorConnect(deps(client), LOGIN);

    expect(step).toEqual({ error: MYINVESTOR_ALREADY_CONNECTED, step: "credentials" });
    expect(client.login).not.toHaveBeenCalled();
    expect(await store.connectedSources.listSources()).toHaveLength(1);
  });
});

describe("the password of a connected row", () => {
  async function connected(): Promise<string> {
    await startMyInvestorConnect(deps(knownDeviceClient()), LOGIN);
    return (await store.connectedSources.listSources())[0]!.id;
  }

  test("saving it checks it with MyInvestor on the known device, with no SMS", async () => {
    const sourceId = await connected();
    const client = knownDeviceClient();

    const result = await saveMyInvestorPassword(deps(client), {
      customerId: "12345678A",
      password: "secret",
      sourceId,
    });

    expect(result).toEqual({ ok: true });
    expect(client.loginWithKnownDevice).toHaveBeenCalledWith({
      customerId: "12345678A",
      password: "secret",
    });
    expect(client.startCode).not.toHaveBeenCalled();
    expect(await storedCredentials()).toEqual({
      acceptance: { acceptedAt: NOW, acceptedBy: "titular@example.com" },
      customerId: "12345678A",
      deviceId: "device-1",
      password: "secret",
    });
  });

  test("a rejected password is not saved", async () => {
    const sourceId = await connected();
    const client = {
      ...knownDeviceClient(),
      loginWithKnownDevice: vi.fn(async () => failure<never>("password_rejected")),
    };

    const result = await saveMyInvestorPassword(deps(client), {
      customerId: "12345678A",
      password: "wrong",
      sourceId,
    });

    expect(result).toEqual({ error: MYINVESTOR_SAVE_REJECTED, ok: false });
    expect(await storedCredentials()).toEqual({ deviceId: "device-1" });
  });

  test("a device MyInvestor no longer trusts asks to reconnect instead of sending an SMS", async () => {
    const sourceId = await connected();
    const client = {
      ...knownDeviceClient(),
      loginWithKnownDevice: vi.fn(async () => failure<never>("sms_required")),
    };

    const result = await saveMyInvestorPassword(deps(client), {
      customerId: "12345678A",
      password: "secret",
      sourceId,
    });

    expect(result).toEqual({ error: MYINVESTOR_DEVICE_LAPSED, ok: false });
    expect(client.startCode).not.toHaveBeenCalled();
  });

  test("forgetting it leaves only the device, at once", async () => {
    await startMyInvestorConnect(deps(knownDeviceClient()), { ...LOGIN, save: true });
    const sourceId = (await store.connectedSources.listSources())[0]!.id;

    expect(await forgetMyInvestorPassword(deps(knownDeviceClient()), sourceId)).toEqual({
      ok: true,
    });

    expect(await storedCredentials()).toEqual({ deviceId: "device-1" });
  });
});

/**
 * The server actions of the MyInvestor connection (#1879): who may connect, and
 * what each terminal is. The login steps themselves are `myinvestor-connect.test.ts`;
 * here the client is a fake handed in through the test seam, and nothing reaches
 * the relay.
 *
 * - A workspace without premium cannot connect (ADR 0114 decision 2).
 * - A viewer cannot (ADR del viewer (#1843)): the write guard refuses before the store is read.
 * - Without the relay configured, there is nothing to connect through.
 * - A rejection and the SMS step come back as state, inside the same fold; only a
 *   finished connection redirects (interaction-patterns §4.1).
 */
import type { StoreTarget } from "@web/store-resolver";
import { createInMemoryStore, type PersistenceTestStore } from "@worthline/db/testing";
import { fixedClock } from "@worthline/domain";
import type { MyInvestorResult } from "@worthline/pricing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { offlineMyInvestorReader } from "./myinvestor-test-reader";

let mockTarget: StoreTarget = { kind: "local" };

vi.mock("@web/read-store-target", () => ({
  readSessionEmail: async () => "titular@example.com",
  readStoreTarget: async () => mockTarget,
}));
vi.mock("@web/entitlements/ingestion-guard", () => ({
  ingestionBlockedMessage: vi.fn(async () => null),
}));

import { VIEWER_READONLY_MESSAGE } from "@web/demo/write-guard";
import { ingestionBlockedMessage } from "@web/entitlements/ingestion-guard";
import {
  PAYWALL_CONNECT_SOURCE_MESSAGE,
  PAYWALL_SOURCES_PAUSED_MESSAGE,
} from "@web/entitlements/paywall-copy";
import {
  cancelMyInvestorCodeAction,
  disconnectMyInvestorAction,
  forgetMyInvestorPasswordAction,
  saveMyInvestorPasswordAction,
  startMyInvestorConnectAction,
  startMyInvestorReenterAction,
  submitMyInvestorCodeAction,
} from "./myinvestor-actions";
import type { MyInvestorConnectClient } from "./myinvestor-connect";
import {
  MYINVESTOR_ACCEPTANCE_TEXT,
  MYINVESTOR_UNAVAILABLE_LINE,
} from "./myinvestor-copy";
import { MYINVESTOR_IDLE } from "./myinvestor-form-state";

const VIEWER: StoreTarget = {
  dbUrl: "libsql://wl-jorge.turso.io",
  kind: "authenticated",
  sharedByEmail: "jorge@example.com",
  token: "read-only-jorge",
  workspaceId: "ws-jorge",
};

const TOKENS = { accessToken: "access", refreshToken: "refresh" };

function ok<T>(value: T): MyInvestorResult<T> {
  return { ok: true, value };
}

function fakeClient(device: "known" | "sms"): MyInvestorConnectClient {
  return {
    login: vi.fn(async () =>
      device === "known"
        ? ok({ kind: "tokens" as const, tokens: TOKENS })
        : ok({
            challenge: { methods: ["OTP_SMS"], requestId: "request-1" },
            kind: "signature" as const,
          }),
    ),
    loginWithKnownDevice: vi.fn(async () => ok(TOKENS)),
    signedLogin: vi.fn(async () => ok(TOKENS)),
    startCode: vi.fn(async () =>
      ok({ destination: null, method: "OTP_SMS", signatureId: "sig-1" }),
    ),
    submitCode: vi.fn(async () => ok(null)),
    reader: vi.fn(() => offlineMyInvestorReader()),
  };
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const LOGIN = {
  currentUrl: "/ajustes/conexiones",
  customerId: "12345678A",
  password: "secret",
};

/** The redirect target of an action that redirected, or throws if it did not. */
async function redirected(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    const signal = error as { digest?: string; message?: string };
    if (signal.message === "NEXT_REDIRECT" && typeof signal.digest === "string") {
      return decodeURIComponent(signal.digest.replaceAll("+", " "));
    }
    throw error;
  }
  throw new Error("the action did not redirect");
}

let store: PersistenceTestStore;

beforeEach(async () => {
  mockTarget = { kind: "local" };
  vi.mocked(ingestionBlockedMessage).mockResolvedValue(null);
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Titular" }],
    mode: "individual",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const clock = fixedClock("2026-11-04T12:00:00.000Z");

describe("who may connect", () => {
  test("a workspace without premium cannot, and MyInvestor is never asked", async () => {
    vi.mocked(ingestionBlockedMessage).mockResolvedValue(PAYWALL_CONNECT_SOURCE_MESSAGE);
    const client = fakeClient("known");

    const state = await startMyInvestorConnectAction(
      MYINVESTOR_IDLE,
      form(LOGIN),
      store,
      { myInvestorClientFor: () => client },
    );

    expect(state).toMatchObject({
      error: PAYWALL_CONNECT_SOURCE_MESSAGE,
      step: "credentials",
    });
    expect(client.login).not.toHaveBeenCalled();
    expect(await store.connectedSources.listSources()).toEqual([]);
  });

  test("a viewer cannot: the write guard refuses before anything is read", async () => {
    mockTarget = VIEWER;
    const client = fakeClient("known");

    const target = await redirected(
      startMyInvestorConnectAction(MYINVESTOR_IDLE, form(LOGIN), store, {
        myInvestorClientFor: () => client,
      }),
    );

    expect(target).toContain(VIEWER_READONLY_MESSAGE);
    expect(client.login).not.toHaveBeenCalled();
    expect(await store.connectedSources.listSources()).toEqual([]);
  });

  test("a viewer cannot finish a code, save a password or disconnect either", async () => {
    mockTarget = VIEWER;

    for (const run of [
      () =>
        submitMyInvestorCodeAction(
          MYINVESTOR_IDLE,
          form({ code: "123456", currentUrl: "/ajustes/conexiones", pendingId: "p" }),
          store,
        ),
      () =>
        saveMyInvestorPasswordAction(
          form({ ...LOGIN, acceptRisk: "on", sourceId: "s" }),
          store,
        ),
      () =>
        forgetMyInvestorPasswordAction(form({ currentUrl: "/x", sourceId: "s" }), store),
      () => disconnectMyInvestorAction(form({ currentUrl: "/x", sourceId: "s" }), store),
    ]) {
      expect(await redirected(run())).toContain(VIEWER_READONLY_MESSAGE);
    }
  });

  test("without the relay configured there is nothing to connect through", async () => {
    vi.stubEnv("MYINVESTOR_RELAY_URL", "");
    vi.stubEnv("MYINVESTOR_RELAY_SECRET", "");

    const state = await startMyInvestorConnectAction(MYINVESTOR_IDLE, form(LOGIN), store);

    expect(state).toMatchObject({
      error: MYINVESTOR_UNAVAILABLE_LINE,
      step: "credentials",
    });
  });
});

describe("the terminals", () => {
  test("a device MyInvestor trusts connects and redirects to the row", async () => {
    const target = await redirected(
      startMyInvestorConnectAction(MYINVESTOR_IDLE, form(LOGIN), store, clock, {
        myInvestorClientFor: () => fakeClient("known"),
      }),
    );

    expect(target).toContain("/ajustes/conexiones");
    expect(target).toContain("ok=myinvestor_connected");
    const [source] = await store.connectedSources.listSources();
    expect(JSON.parse(source!.credentialsJson)).toEqual({
      deviceId: expect.any(String),
    });
  });

  test("the box, ticked, keeps the password with who accepted it", async () => {
    await redirected(
      startMyInvestorConnectAction(
        MYINVESTOR_IDLE,
        form({ ...LOGIN, savePassword: "on" }),
        store,
        clock,
        { myInvestorClientFor: () => fakeClient("known") },
      ),
    );

    const [source] = await store.connectedSources.listSources();
    expect(JSON.parse(source!.credentialsJson)).toMatchObject({
      acceptance: {
        acceptedAt: "2026-11-04T12:00:00.000Z",
        acceptedBy: "titular@example.com",
      },
      customerId: "12345678A",
      password: "secret",
    });
  });

  test("the SMS comes back as state in the same fold, then the code connects", async () => {
    const client = fakeClient("sms");
    const override = { myInvestorClientFor: () => client };

    const sms = await startMyInvestorConnectAction(
      MYINVESTOR_IDLE,
      form(LOGIN),
      store,
      clock,
      override,
    );
    expect(sms).toMatchObject({ expiresAt: "2026-11-04T12:05:00.000Z", step: "sms" });
    // The password never travels back to the browser in the state.
    expect(JSON.stringify(sms)).not.toContain("secret");

    const pendingId = sms.step === "sms" ? sms.pendingId : "";
    const target = await redirected(
      submitMyInvestorCodeAction(
        sms,
        form({ code: "123456", currentUrl: "/ajustes/conexiones", pendingId }),
        store,
        clock,
        override,
      ),
    );
    expect(target).toContain("ok=myinvestor_connected");
  });

  test("a code that is not one is refused without asking MyInvestor", async () => {
    const client = fakeClient("sms");
    const override = { myInvestorClientFor: () => client };
    const sms = await startMyInvestorConnectAction(
      MYINVESTOR_IDLE,
      form(LOGIN),
      store,
      clock,
      override,
    );
    const pendingId = sms.step === "sms" ? sms.pendingId : "";

    const state = await submitMyInvestorCodeAction(
      sms,
      form({ code: "abc", currentUrl: "/ajustes/conexiones", pendingId }),
      store,
      clock,
      override,
    );

    expect(state).toMatchObject({ pendingId, step: "sms" });
    expect(state.step === "sms" && state.error).toBeTruthy();
    expect(client.submitCode).not.toHaveBeenCalled();
  });

  test("«Empezar de nuevo» deletes the pending step at once", async () => {
    const sms = await startMyInvestorConnectAction(
      MYINVESTOR_IDLE,
      form(LOGIN),
      store,
      clock,
      { myInvestorClientFor: () => fakeClient("sms") },
    );
    const pendingId = sms.step === "sms" ? sms.pendingId : "";

    await cancelMyInvestorCodeAction(form({ pendingId }), store);

    expect(await store.connectedSources.readPendingLogin(pendingId)).toBeNull();
  });
});

describe("the connected row", () => {
  async function connectedSourceId(save: boolean): Promise<string> {
    await redirected(
      startMyInvestorConnectAction(
        MYINVESTOR_IDLE,
        form(save ? { ...LOGIN, savePassword: "on" } : LOGIN),
        store,
        clock,
        { myInvestorClientFor: () => fakeClient("known") },
      ),
    );
    return (await store.connectedSources.listSources())[0]!.id;
  }

  test("saving the password needs the box ticked", async () => {
    const sourceId = await connectedSourceId(false);

    const target = await redirected(
      saveMyInvestorPasswordAction(form({ ...LOGIN, sourceId }), store, clock, {
        myInvestorClientFor: () => fakeClient("known"),
      }),
    );

    expect(target).toContain("form=myinvestor-password");
    expect(target).toContain(MYINVESTOR_ACCEPTANCE_TEXT.slice(0, 20));
    const [source] = await store.connectedSources.listSources();
    expect(JSON.parse(source!.credentialsJson)).not.toHaveProperty("password");
  });

  test("saving the password asks MyInvestor nothing", async () => {
    const sourceId = await connectedSourceId(false);
    const client = fakeClient("known");
    const clientFor = vi.fn(() => client);

    const target = await redirected(
      saveMyInvestorPasswordAction(
        form({ ...LOGIN, acceptRisk: "on", inlineError: "1", sourceId }),
        store,
        clock,
        { myInvestorClientFor: clientFor },
      ),
    );

    expect(target).toContain("ok=myinvestor_password_saved");
    expect(clientFor).not.toHaveBeenCalled();
    const [source] = await store.connectedSources.listSources();
    expect(JSON.parse(source!.credentialsJson)).toMatchObject({ password: "secret" });
  });

  test("with the box, an accepted password is saved", async () => {
    const sourceId = await connectedSourceId(false);

    const target = await redirected(
      saveMyInvestorPasswordAction(
        form({ ...LOGIN, acceptRisk: "on", sourceId }),
        store,
        clock,
        { myInvestorClientFor: () => fakeClient("known") },
      ),
    );

    expect(target).toContain("ok=myinvestor_password_saved");
    const [source] = await store.connectedSources.listSources();
    expect(JSON.parse(source!.credentialsJson)).toMatchObject({ password: "secret" });
  });

  test("«Dejar de guardarla» deletes the password at once", async () => {
    const sourceId = await connectedSourceId(true);

    const target = await redirected(
      forgetMyInvestorPasswordAction(
        form({ currentUrl: "/ajustes/conexiones", sourceId }),
        store,
      ),
    );

    expect(target).toContain("ok=myinvestor_password_forgotten");
    const [source] = await store.connectedSources.listSources();
    expect(JSON.parse(source!.credentialsJson)).toEqual({ deviceId: expect.any(String) });
  });

  test("«Volver a entrar» after the SMS stop: the code re-enters the same row and lifts the stop", async () => {
    const sourceId = await connectedSourceId(false);
    await store.connectedSources.updateSyncState(sourceId, {
      stoppedReason: "sms_required",
    });
    const override = { myInvestorClientFor: () => fakeClient("sms") };

    const sms = await startMyInvestorReenterAction(
      MYINVESTOR_IDLE,
      form({ ...LOGIN, sourceId }),
      store,
      clock,
      override,
    );
    expect(sms).toMatchObject({ step: "sms" });
    const pendingId = sms.step === "sms" ? sms.pendingId : "";
    const target = await redirected(
      submitMyInvestorCodeAction(
        sms,
        form({ code: "123456", currentUrl: "/ajustes/conexiones", pendingId }),
        store,
        clock,
        override,
      ),
    );

    expect(target).toContain("ok=myinvestor_reentered");
    expect((await store.connectedSources.listSources()).map((s) => s.id)).toEqual([
      sourceId,
    ]);
    expect((await store.connectedSources.readSyncState(sourceId))?.stoppedReason).toBe(
      null,
    );
  });

  test("«Volver a entrar» refused comes back as state, inside the fold", async () => {
    vi.mocked(ingestionBlockedMessage).mockResolvedValue(PAYWALL_SOURCES_PAUSED_MESSAGE);
    const client = fakeClient("known");

    const state = await startMyInvestorReenterAction(
      MYINVESTOR_IDLE,
      form({ ...LOGIN, sourceId: "s" }),
      store,
      clock,
      { myInvestorClientFor: () => client },
    );

    expect(state).toMatchObject({
      customerId: "12345678A",
      error: PAYWALL_SOURCES_PAUSED_MESSAGE,
      step: "credentials",
    });
    expect(client.login).not.toHaveBeenCalled();
  });

  test("disconnecting deletes the connection and its credentials", async () => {
    const sourceId = await connectedSourceId(true);

    const target = await redirected(
      disconnectMyInvestorAction(
        form({ currentUrl: "/ajustes/conexiones", sourceId }),
        store,
      ),
    );

    expect(target).toContain("ok=myinvestor_disconnected");
    expect(await store.connectedSources.listSources()).toEqual([]);
  });
});

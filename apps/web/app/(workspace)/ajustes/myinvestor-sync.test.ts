/**
 * «Poner al día» end to end (#1884, acceptance), over the anonymized fixtures of
 * #1887 behind a FAKE client: the login answers what each case needs and the reads
 * can be bent, so every error of ADR 0114 decision 7 meets its action, and nothing
 * reaches the network.
 *
 * - Each error and its action: the password rejected (deleted, three a day lock
 *   until tomorrow), a rejection with no reason (24 h, password kept), the network
 *   (nothing changes), the SMS (the periodic sync stops, and nothing ever sends one).
 * - At most 10 logins a day.
 * - The cron skips a connection with no password, in pause or stopped.
 * - Two triggers at once make ONE pass; the second waits for it.
 * - A units mismatch gives the check and no adjustment (P8).
 * - A periodic pass over an overlapping window applies nothing twice.
 */
import { createStoreFromSqlite, openLibsqlClient, runDailyCapture } from "@worthline/db";
import { addUnits, derivePosition, fixedClock } from "@worthline/domain";
import type {
  MyInvestorClient,
  MyInvestorErrorKind,
  MyInvestorOrder,
  MyInvestorReader,
  MyInvestorTransport,
  ResolveFxRateSnapshotOptions,
} from "@worthline/pricing";
import { createMyInvestorClient } from "@worthline/pricing";
import { fixtureTransport } from "@worthline/pricing/testing";
import { beforeEach, describe, expect, test } from "vitest";

import { startMyInvestorConnect } from "./myinvestor-connect";
import { hasSavedPassword, readMyInvestorCredentials } from "./myinvestor-credentials";
import {
  includeMyInvestorProducts,
  loadMyInvestorFirstStart,
  storeMyInvestorDiscovery,
} from "./myinvestor-first-start-flow";
import { isIncludable } from "./myinvestor-selection";
import {
  type MyInvestorSyncDeps,
  type MyInvestorSyncResult,
  runMyInvestorRefresh,
  runMyInvestorSync,
} from "./myinvestor-sync";
import { parseMyInvestorUnitsCheck } from "./myinvestor-sync-outcome";

/** The day the fixtures were captured: the `dateTo` their manifest records. */
const TODAY = "2026-11-04";
const NOW = `${TODAY}T09:00:00.000Z`;
const TYPED = { customerId: "00000000A", password: "sintetica" };

type Store = Awaited<ReturnType<typeof createStoreFromSqlite>>;
type SyncClient = Pick<MyInvestorClient, "loginWithKnownDevice" | "reader">;

let client: ReturnType<typeof openLibsqlClient>;
let store: Store;
let ids = 0;

function fixtureClient(deviceId: string) {
  return createMyInvestorClient({
    deviceId,
    sleep: async () => {},
    transport: fixtureTransport(),
  });
}

/**
 * The fixtures recorded the orders of the whole history only. A periodic pass asks
 * for a window; this answers it with the recorded read — a wider overlap than the
 * real one, which is exactly what must apply nothing twice.
 */
function windowedFixtureTransport(
  prefer?: (file: string) => boolean,
): MyInvestorTransport {
  const fixtures = fixtureTransport(prefer ? { prefer } : {});
  return {
    send: (request) => {
      const query = request.query;
      if (!query?.dateFrom || !query.dateTo) return fixtures.send(request);
      const dashed = query.dateFrom.includes("-");
      return fixtures.send({
        ...request,
        query: {
          ...query,
          dateFrom: dashed ? "2000-01-01" : "20000101",
          dateTo: dashed ? TODAY : TODAY.replaceAll("-", ""),
        },
      });
    },
  };
}

function windowedClient(deviceId: string, prefer?: (file: string) => boolean) {
  return createMyInvestorClient({
    deviceId,
    sleep: async () => {},
    transport: windowedFixtureTransport(prefer),
  });
}

/** What the fake client does, and what it was asked. */
interface FakeClient {
  logins: number;
  /** The login answers this error instead of the fixture's session. */
  refuse: MyInvestorErrorKind | null;
  /** Bends the fixture reader. */
  bend: (reader: MyInvestorReader) => MyInvestorReader;
  /** Resolves when a login arrives; the login then waits for `gate`. */
  gate: Promise<void> | null;
  clientFor: (deviceId: string) => SyncClient;
}

function fakeClient(prefer?: (file: string) => boolean): FakeClient {
  const fake: FakeClient = {
    bend: (reader) => reader,
    clientFor: (deviceId) => {
      const real = windowedClient(deviceId, prefer);
      return {
        loginWithKnownDevice: async (credentials) => {
          fake.logins += 1;
          if (fake.gate) await fake.gate;
          if (fake.refuse) {
            return {
              error: {
                attempts: 1,
                code: fake.refuse === "rejected_no_reason" ? "SECURITY_001" : null,
                httpStatus: 403,
                kind: fake.refuse,
                step: "login",
              },
              ok: false,
            };
          }
          return real.loginWithKnownDevice(credentials);
        },
        reader: (tokens) => fake.bend(real.reader(tokens)),
      };
    },
    gate: null,
    logins: 0,
    refuse: null,
  };
  return fake;
}

/** A clock the test moves. */
function movableClock(start: string) {
  let at = Date.parse(start);
  return {
    advanceHours: (hours: number) => {
      at += hours * 3_600_000;
    },
    now: () => new Date(at).toISOString(),
    today: () => new Date(at).toISOString().slice(0, 10),
  };
}

function deps(
  fake: FakeClient,
  clock = movableClock(NOW),
): MyInvestorSyncDeps & { clock: ReturnType<typeof movableClock> } {
  return {
    clientFor: fake.clientFor,
    clock,
    now: clock.now,
    sleep: async () => {},
    store,
    today: clock.today,
  };
}

async function connectIncludeAll(save: boolean): Promise<string> {
  const step = await startMyInvestorConnect(
    {
      acceptedBy: null,
      afterConnect: ({ reader, sourceId }) =>
        storeMyInvestorDiscovery({ now: NOW, store, today: TODAY }, { reader, sourceId }),
      clientFor: fixtureClient,
      newDeviceId: () => "device-sintetico",
      now: NOW,
      store: store.connectedSources,
    },
    { ...TYPED, save },
  );
  expect(step.step).toBe("connected");
  const source = (await store.connectedSources.listSources()).find(
    (row) => row.adapter === "myinvestor",
  )!;
  const { view } = (await loadMyInvestorFirstStart(store, source.id, TODAY))!;
  const own = view.own.flatMap((group) => group.products).filter(isIncludable);
  const included = await includeMyInvestorProducts(
    {
      newAssetId: () => `asset_${++ids}`,
      resolveSymbol: async () => null,
      store,
      today: TODAY,
    },
    { productKeys: own.map((row) => row.key), sourceId: source.id },
  );
  expect(included.ok).toBe(true);
  return source.id;
}

async function operationCount(): Promise<number> {
  const rows = await client.execute("SELECT COUNT(*) AS n FROM asset_operations");
  return Number(rows.rows[0]!.n);
}

async function credentialsOf(sourceId: string) {
  const source = await store.connectedSources.readSource(sourceId);
  return readMyInvestorCredentials(source!.credentialsJson)!;
}

function outcomeOf(result: MyInvestorSyncResult) {
  if (result.status !== "done") throw new Error(`Expected a pass, got ${result.status}`);
  return result.outcome;
}

beforeEach(async () => {
  ids = 0;
  client = openLibsqlClient(":memory:");
  store = await createStoreFromSqlite(client, { clock: fixedClock(NOW) });
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Titular" }],
    mode: "individual",
  });
});

describe("a good pass", () => {
  test("an overlapping window applies nothing twice; a new order lands once", async () => {
    const sourceId = await connectIncludeAll(true);
    const before = await operationCount();
    const fake = fakeClient();

    const first = outcomeOf(
      await runMyInvestorSync(deps(fake), { sourceId, trigger: "manual", typed: null }),
    );
    expect(first).toMatchObject({ applied: 0, kind: "ok", mismatches: 0 });
    expect(await operationCount()).toBe(before);

    // A new subscription of a linked fund, inside the window of the next pass.
    const { discovery } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
    const linked = new Set(
      (await store.connectedSources.readLinks(sourceId)).map((link) => link.productKey),
    );
    const fundProduct = discovery.products.find(
      (product) => product.kind === "fund" && linked.has(product.key),
    )!;
    const accountId = fundProduct.accountKey.replace("securities:", "");
    const order: MyInvestorOrder = {
      accountId,
      amountToBlock: null,
      cash: "13.37",
      currency: "EUR",
      dgsCode: null,
      effectiveDate: null,
      executionNav: "10.837",
      expirationDate: null,
      fundName: fundProduct.name,
      isin: fundProduct.instrument!.code,
      market: null,
      operationType: "INVESTMENT_FUNDS_SUBSCRIPTION",
      orderDate: "2026-11-02",
      orderType: null,
      productType: null,
      reference: "sintetica-nueva-1",
      shares: "1.2337",
      status: "COMPLETE",
      ticker: null,
    };
    fake.bend = (reader) => ({
      ...reader,
      securitiesOrders: async (id, range) => {
        const read = await reader.securitiesOrders(id, range);
        return read.ok && id === accountId
          ? { ok: true, value: [...read.value, order] }
          : read;
      },
    });

    const second = outcomeOf(
      await runMyInvestorSync(deps(fake), { sourceId, trigger: "cron", typed: null }),
    );
    const third = outcomeOf(
      await runMyInvestorSync(deps(fake), { sourceId, trigger: "manual", typed: null }),
    );

    expect(second).toMatchObject({ applied: 1, kind: "ok" });
    expect(third).toMatchObject({ applied: 0, kind: "ok" });
    expect(await operationCount()).toBe(before + 1);
    // The stored read is refreshed with it, so a later include uses fresh data.
    const refreshed = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!.discovery;
    expect(refreshed.operations.some((fact) => fact.key === "sintetica-nueva-1")).toBe(
      true,
    );
    expect(refreshed.contributions).toBeDefined();
  });

  test("a units mismatch: the operations land, the check says by how much, no adjustment", async () => {
    const sourceId = await connectIncludeAll(true);
    const before = await operationCount();
    const fake = fakeClient();
    let bentIsin: string | null = null;
    fake.bend = (reader) => ({
      ...reader,
      securitiesAccount: async (id) => {
        const read = await reader.securitiesAccount(id);
        if (!read.ok) return read;
        const [first, ...rest] = read.value.positions;
        if (!first?.isin || bentIsin !== null) return read;
        bentIsin = first.isin;
        return {
          ok: true,
          value: {
            ...read.value,
            positions: [{ ...first, shares: addUnits(first.shares, "0.33") }, ...rest],
          },
        };
      },
    });

    const outcome = outcomeOf(
      await runMyInvestorSync(deps(fake), { sourceId, trigger: "cron", typed: null }),
    );

    expect(outcome).toMatchObject({ kind: "ok", mismatches: 1 });
    expect(await operationCount()).toBe(before);
    const state = await store.connectedSources.readSyncState(sourceId);
    const check = parseMyInvestorUnitsCheck(state!.unitsCheckJson);
    expect(check).toHaveLength(1);
    expect(check[0]!.difference).toBe("0.33");
    // No adjustment: the book still folds to what it held.
    const units = derivePosition(
      await store.operations.readOperations(check[0]!.assetId),
      { assetId: check[0]!.assetId, currency: "EUR" },
    ).currentUnits;
    expect(units).toBe(check[0]!.bookUnits);
  });
});

describe("each error and its action (ADR 0114, decision 7)", () => {
  test("a rejected saved password is deleted and the cron stops; never retried", async () => {
    const sourceId = await connectIncludeAll(true);
    const fake = fakeClient();
    fake.refuse = "password_rejected";

    const outcome = outcomeOf(
      await runMyInvestorSync(deps(fake), { sourceId, trigger: "cron", typed: null }),
    );

    expect(outcome.kind).toBe("password_rejected");
    const credentials = await credentialsOf(sourceId);
    expect(hasSavedPassword(credentials)).toBe(false);
    expect(credentials.deviceId).toBe("device-sintetico");

    const next = await runMyInvestorSync(deps(fake), {
      sourceId,
      trigger: "cron",
      typed: null,
    });
    expect(next).toEqual({ reason: "no_password", status: "skipped" });
    expect(fake.logins).toBe(1);
  });

  test("three rejections in one day lock the connection until the next day", async () => {
    const sourceId = await connectIncludeAll(false);
    const fake = fakeClient();
    fake.refuse = "password_rejected";
    const run = deps(fake);
    const press = () =>
      runMyInvestorSync(run, { sourceId, trigger: "manual", typed: TYPED });

    expect(outcomeOf(await press()).kind).toBe("password_rejected");
    expect(outcomeOf(await press()).kind).toBe("password_rejected");
    const third = outcomeOf(await press());
    expect(third).toMatchObject({ kind: "locked", until: "2026-11-05T00:00:00.000Z" });

    expect(await press()).toEqual({
      reason: "locked",
      status: "blocked",
      until: "2026-11-05T00:00:00.000Z",
    });
    expect(fake.logins).toBe(3);

    run.clock.advanceHours(15);
    fake.refuse = null;
    expect(outcomeOf(await press()).kind).toBe("ok");
  });

  test("a rejection with no reason (SECURITY_001) pauses 24 h and keeps the password", async () => {
    const sourceId = await connectIncludeAll(true);
    const fake = fakeClient();
    fake.refuse = "rejected_no_reason";
    const run = deps(fake);

    const outcome = outcomeOf(
      await runMyInvestorSync(run, { sourceId, trigger: "cron", typed: null }),
    );
    expect(outcome).toMatchObject({
      kind: "rejected_no_reason",
      until: "2026-11-05T09:00:00.000Z",
    });
    expect(hasSavedPassword(await credentialsOf(sourceId))).toBe(true);

    run.clock.advanceHours(23);
    expect(
      await runMyInvestorSync(run, { sourceId, trigger: "manual", typed: null }),
    ).toEqual({
      reason: "rejected_no_reason",
      status: "blocked",
      until: "2026-11-05T09:00:00.000Z",
    });
    expect(
      await runMyInvestorSync(run, { sourceId, trigger: "cron", typed: null }),
    ).toEqual({ reason: "paused", status: "skipped" });
    expect(fake.logins).toBe(1);

    run.clock.advanceHours(2);
    fake.refuse = null;
    expect(
      outcomeOf(await runMyInvestorSync(run, { sourceId, trigger: "cron", typed: null }))
        .kind,
    ).toBe("ok");
  });

  test("the network or the WAF: the pass ends in error and nothing changes", async () => {
    const sourceId = await connectIncludeAll(true);
    const before = await operationCount();
    const fake = fakeClient();
    fake.refuse = "network_or_waf";

    const outcome = outcomeOf(
      await runMyInvestorSync(deps(fake), { sourceId, trigger: "cron", typed: null }),
    );

    expect(outcome.kind).toBe("network");
    expect(await operationCount()).toBe(before);
    expect(hasSavedPassword(await credentialsOf(sourceId))).toBe(true);
    const state = await store.connectedSources.readSyncState(sourceId);
    expect(state).toMatchObject({ pausedUntil: null, stoppedReason: null });
  });

  test("the SMS required stops the cron, which never sends one", async () => {
    const sourceId = await connectIncludeAll(true);
    const fake = fakeClient();
    fake.refuse = "sms_required";

    const outcome = outcomeOf(
      await runMyInvestorSync(deps(fake), { sourceId, trigger: "cron", typed: null }),
    );
    expect(outcome.kind).toBe("sms_required");
    expect(
      await runMyInvestorSync(deps(fake), { sourceId, trigger: "cron", typed: null }),
    ).toEqual({ reason: "stopped", status: "skipped" });
    // The fake client has no `startCode`: had the pass asked for an SMS, it would throw.
    expect(fake.logins).toBe(1);
  });

  test("at most 10 logins a day, counting the button and the cron", async () => {
    const sourceId = await connectIncludeAll(true);
    const fake = fakeClient();
    fake.refuse = "network_or_waf";
    const run = deps(fake);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const trigger = attempt % 2 === 0 ? "manual" : "cron";
      expect(
        outcomeOf(await runMyInvestorSync(run, { sourceId, trigger, typed: null })).kind,
      ).toBe("network");
    }
    const eleventh = outcomeOf(
      await runMyInvestorSync(run, { sourceId, trigger: "manual", typed: null }),
    );

    expect(eleventh.kind).toBe("limit");
    expect(fake.logins).toBe(10);
  });
});

describe("the attempt log (#1885)", () => {
  test("a failed attempt leaves one row: kind, step, HTTP status and duration, no personal data", async () => {
    const sourceId = await connectIncludeAll(true);
    const fake = fakeClient();
    const run = deps(fake);
    fake.bend = (reader) => ({
      ...reader,
      securitiesOrders: async () => {
        // The orders take 37 s to fail, so the row's two instants say how long.
        run.clock.advanceHours(37 / 3600);
        return {
          error: {
            attempts: 3,
            code: null,
            httpStatus: 503,
            kind: "network_or_waf",
            step: "orders",
          },
          ok: false,
        };
      },
    });

    const outcome = outcomeOf(
      await runMyInvestorSync(run, { sourceId, trigger: "cron", typed: null }),
    );
    expect(outcome.kind).toBe("network");

    const runs = await store.syncRuns.readRuns(sourceId);
    expect(runs).toEqual([
      {
        createdAt: NOW,
        error: {
          code: "network_or_waf",
          httpStatus: 503,
          message: "network",
          retriable: true,
          step: "orders",
        },
        finishedAt: "2026-11-04T09:00:37.000Z",
        id: expect.any(String),
        sourceId,
        startedAt: NOW,
        status: "error",
        trigger: "cron",
      },
    ]);
    // Nothing of the user's crosses into the row: no username, password, device,
    // ISIN nor amount of what the connection holds.
    const isins = (await loadMyInvestorFirstStart(
      store,
      sourceId,
      TODAY,
    ))!.discovery.products
      .map((product) => product.instrument?.code)
      .filter((code): code is string => Boolean(code));
    const raw = JSON.stringify(runs);
    for (const secret of [
      TYPED.customerId,
      TYPED.password,
      "device-sintetico",
      ...isins,
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  test("a good pass is an `ok` row of the button; a login refused is a row of its step", async () => {
    const sourceId = await connectIncludeAll(true);
    const fake = fakeClient();

    const run = deps(fake);
    await runMyInvestorSync(run, { sourceId, trigger: "manual", typed: null });
    run.clock.advanceHours(1);
    fake.refuse = "rejected_no_reason";
    await runMyInvestorSync(run, { sourceId, trigger: "cron", typed: null });

    const runs = await store.syncRuns.readRuns(sourceId);
    expect(runs.map((row) => [row.trigger, row.status, row.error])).toEqual([
      [
        "cron",
        "error",
        {
          code: "rejected_no_reason",
          httpStatus: 403,
          message: "rejected_no_reason",
          retriable: false,
          step: "login",
        },
      ],
      ["manual", "ok", null],
    ]);
  });

  test("a press refused before MyInvestor is asked (the day's limit, a pause) is no attempt", async () => {
    const sourceId = await connectIncludeAll(true);
    const fake = fakeClient();
    fake.refuse = "rejected_no_reason";
    const run = deps(fake);

    await runMyInvestorSync(run, { sourceId, trigger: "cron", typed: null });
    await runMyInvestorSync(run, { sourceId, trigger: "manual", typed: null });

    expect(await store.syncRuns.readRuns(sourceId)).toHaveLength(1);
  });

  test("the cron purges the attempts older than 90 days of a connection it skips", async () => {
    const sourceId = await connectIncludeAll(false);
    await store.connectedSources.recordSyncAttempt({
      error: null,
      finishedAt: "2026-07-30T09:00:00.000Z",
      sourceId,
      startedAt: "2026-07-30T09:00:00.000Z",
      trigger: "manual",
    });

    await runMyInvestorRefresh(store, NOW, {
      clientFor: fakeClient().clientFor,
      now: () => NOW,
      sleep: async () => {},
    });

    expect(await store.syncRuns.readRuns(sourceId)).toEqual([]);
  });
});

describe("a robo-advisor with a fund in its USD class (#1899)", () => {
  const preferUsd = (file: string) => file.includes("roboadvisor-usd");
  const ACCOUNT = "9100009";

  /** The ECB, offline: one dollar is worth 0,90 € every day it is asked about. */
  const ecbAt090: ResolveFxRateSnapshotOptions = {
    fetchDailyRates: async (_currency, fromMs, toMs) => {
      const rates = new Map<string, number>();
      for (let at = fromMs; at <= toMs; at += 86_400_000) {
        rates.set(new Date(at).toISOString().slice(0, 10), 0.9);
      }
      return rates;
    },
  };
  const ecbDown: ResolveFxRateSnapshotOptions = {
    fetchDailyRates: async () => new Map(),
  };

  function order(
    reference: string,
    isin: string,
    currency: string,
    cash: string,
    shares: string,
  ): MyInvestorOrder {
    return {
      accountId: ACCOUNT,
      amountToBlock: null,
      cash,
      currency,
      dgsCode: null,
      effectiveDate: null,
      executionNav: null,
      expirationDate: null,
      fundName: null,
      isin,
      market: null,
      operationType: "INVESTMENT_FUNDS_SUBSCRIPTION",
      orderDate: "2026-11-02",
      orderType: null,
      productType: null,
      reference,
      shares,
      status: "COMPLETE",
      ticker: null,
    };
  }

  async function connectIncludeUsd(): Promise<string> {
    const step = await startMyInvestorConnect(
      {
        acceptedBy: null,
        afterConnect: ({ reader, sourceId }) =>
          storeMyInvestorDiscovery(
            { now: NOW, store, today: TODAY },
            { reader, sourceId },
          ),
        clientFor: (deviceId) => windowedClient(deviceId, preferUsd),
        newDeviceId: () => "device-sintetico",
        now: NOW,
        store: store.connectedSources,
      },
      { ...TYPED, save: true },
    );
    expect(step.step).toBe("connected");
    const source = (await store.connectedSources.listSources()).find(
      (row) => row.adapter === "myinvestor",
    )!;
    const { view } = (await loadMyInvestorFirstStart(store, source.id, TODAY, {
      fx: ecbAt090,
    }))!;
    const managed = view.rows.find((row) => row.kind === "managed")!;
    const included = await includeMyInvestorProducts(
      {
        fx: ecbAt090,
        newAssetId: () => `asset_${++ids}`,
        resolveSymbol: async () => null,
        store,
        today: TODAY,
      },
      { productKeys: [managed.key], sourceId: source.id },
    );
    expect(included.ok).toBe(true);
    return source.id;
  }

  async function operationById(id: string) {
    const rows = await client.execute({
      args: [id],
      sql: "SELECT currency, capture_currency, capture_eur_per_unit FROM asset_operations WHERE id = ?",
    });
    return rows.rows[0] ?? null;
  }

  test("with the ECB down the dollar order waits, the rest lands; the next pass applies it in euros", async () => {
    const sourceId = await connectIncludeUsd();
    const before = await operationCount();
    const fake = fakeClient(preferUsd);
    const fresh = [
      order("sintetica-usd-nueva", "IE00SINTET45", "USD", "22.10", "2"),
      order("sintetica-eur-nueva", "IE00SINTET52", "EUR", "20.80", "2"),
    ];
    fake.bend = (reader) => ({
      ...reader,
      securitiesOrders: async (id, range) => {
        const read = await reader.securitiesOrders(id, range);
        return read.ok && id === ACCOUNT
          ? { ok: true, value: [...read.value, ...fresh] }
          : read;
      },
    });

    const down = outcomeOf(
      await runMyInvestorSync(
        { ...deps(fake), fx: ecbDown },
        { sourceId, trigger: "cron", typed: null },
      ),
    );
    expect(down).toMatchObject({ applied: 1, kind: "ok" });
    expect(await operationCount()).toBe(before + 1);
    expect(await operationById(`mi_${sourceId}_sintetica-usd-nueva`)).toBeNull();

    // A day later the ECB answers, and the window may no longer hold the order: it
    // is planned anyway until it lands, and lands once.
    const clock = movableClock(NOW);
    clock.advanceHours(24);
    fake.bend = (reader) => reader;
    const back = outcomeOf(
      await runMyInvestorSync(
        { ...deps(fake, clock), fx: ecbAt090 },
        { sourceId, trigger: "cron", typed: null },
      ),
    );
    expect(back).toMatchObject({ applied: 1, kind: "ok" });
    expect(await operationById(`mi_${sourceId}_sintetica-usd-nueva`)).toMatchObject({
      capture_currency: "USD",
      capture_eur_per_unit: "0.9",
      currency: "EUR",
    });
    const again = outcomeOf(
      await runMyInvestorSync(
        { ...deps(fake, clock), fx: ecbAt090 },
        { sourceId, trigger: "manual", typed: null },
      ),
    );
    expect(again).toMatchObject({ applied: 0, kind: "ok" });
    expect(await operationCount()).toBe(before + 2);
  });
});

describe("one pass per connection", () => {
  test("two triggers at once make ONE pass; the second waits and shares its result", async () => {
    const sourceId = await connectIncludeAll(true);
    const fake = fakeClient();
    let open: () => void = () => {};
    fake.gate = new Promise((resolve) => {
      open = resolve;
    });
    const run = deps(fake);
    let polls = 0;
    const waiting = {
      ...run,
      sleep: async () => {
        polls += 1;
        // The first pass is held at its login until the second has seen it waiting.
        if (polls === 1) open();
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    };

    const first = runMyInvestorSync(waiting, { sourceId, trigger: "cron", typed: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = runMyInvestorSync(waiting, {
      sourceId,
      trigger: "manual",
      typed: null,
    });
    const [a, b] = await Promise.all([first, second]);

    expect(fake.logins).toBe(1);
    expect(a).toMatchObject({ outcome: { kind: "ok" }, status: "done", waited: false });
    expect(b).toMatchObject({ outcome: { kind: "ok" }, status: "done", waited: true });
  });
});

describe("the cron (the daily capture's source-sync phase)", () => {
  test("it skips a connection with no saved password, without asking MyInvestor", async () => {
    await connectIncludeAll(false);
    const fake = fakeClient();

    const result = await runMyInvestorRefresh(store, NOW, {
      clientFor: fake.clientFor,
      now: () => NOW,
      sleep: async () => {},
    });

    expect(result).toEqual({ errors: [] });
    expect(fake.logins).toBe(0);
  });

  test("without premium the capture skips the phase: MyInvestor is never asked", async () => {
    await connectIncludeAll(true);
    const fake = fakeClient();
    const open = new Proxy(store, {
      get: (target, prop, receiver) =>
        prop === "close" ? () => {} : Reflect.get(target, prop, receiver),
    });
    const capture = (premium: boolean) =>
      runDailyCapture({
        fetchPrices: async () => [],
        listAllWorkspaces: async () => [{ dbUrl: "libsql://ws", id: "ws" }],
        now: NOW,
        openStore: async () => open,
        shouldSyncConnectedSources: async () => premium,
        syncConnectedSources: (opened, now) =>
          runMyInvestorRefresh(opened, now, {
            clientFor: fake.clientFor,
            now: () => NOW,
            sleep: async () => {},
          }),
      });

    await capture(false);
    expect(fake.logins).toBe(0);

    await capture(true);
    expect(fake.logins).toBe(1);
  });

  test("it reports a failed pass by its kind, never with data", async () => {
    await connectIncludeAll(true);
    const fake = fakeClient();
    fake.refuse = "network_or_waf";

    const result = await runMyInvestorRefresh(store, NOW, {
      clientFor: fake.clientFor,
      now: () => NOW,
      sleep: async () => {},
    });

    // The kind, the step and the HTTP status: what the maintainer alert needs, no data.
    expect(result).toEqual({ errors: ["MyInvestor: network (login, HTTP 403)"] });
  });
});

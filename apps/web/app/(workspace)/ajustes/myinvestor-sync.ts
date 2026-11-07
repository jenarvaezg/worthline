/**
 * «Poner al día» of MyInvestor (#1884, PRD #1876 S9; ADR 0114 decisions 4, 5 and
 * 7; #1869 P8), as one function over ports: the store, a client bound to the
 * connection's device, the clock and a sleep. The button, the cron and the tests
 * all run {@link runMyInvestorSync}; the decisions about what the reads mean are
 * pure, in `myinvestor-sync-plan.ts`.
 *
 * A pass:
 * 1. **Gates.** The cron only runs with a saved password, with no stop (the SMS)
 *    and no pause. The button runs with the saved password or the one typed now —
 *    used for this pass and never kept — and refuses while paused.
 * 2. **One pass per connection.** It claims the connection's lease. The cron skips
 *    a connection another pass holds; the button WAITS for that pass and answers
 *    with its result instead of starting a second one.
 * 3. **At most 10 logins a day**, reserved before MyInvestor is asked.
 * 4. **The reads**: positions and cash, the orders from the cursor minus 30 days,
 *    plans and scheduled contributions — each step written down for the panel.
 * 5. **The batch**: the new operations of the linked holdings and today's cash
 *    balances, ONE batch (ADR 0062); the stored read is refreshed with what was
 *    read, so «Incluir con su histórico» never applies a stale one.
 * 6. **The units check** (P8): each linked holding's book against MyInvestor's
 *    units, exact. A mismatch is kept as a signal with «Resincronizar todo»; the
 *    operations stay applied and NOTHING adjusts them (invariant 6).
 *
 * Each error maps to its action (decision 7): a rejected password is deleted (if
 * saved) and three a day lock until tomorrow; a rejection with no reason
 * (`SECURITY_001`) pauses 24 h and keeps the password; the network or the WAF only
 * fail the pass (the client already retried); an SMS stops the cron, which never
 * sends one (invariant 7).
 *
 * Every pass that asked MyInvestor leaves ONE row in the attempt log (#1885,
 * decision 8): when, button or cron, how it ended, the error's kind, the step that
 * failed, the HTTP status and, from its two instants, how long it took. Never an
 * amount, an ISIN nor an identifier. A press refused before MyInvestor is asked (a
 * pause, the day's limit) is no attempt and leaves none.
 */
import type { WorthlineStore } from "@web/store";
import type { SyncRunError } from "@worthline/db";
import type { DateKey, DecimalString } from "@worthline/domain";
import { asDateKey, netUnitsFromOperations } from "@worthline/domain";
import type {
  MyInvestorClient,
  MyInvestorCredentials,
  MyInvestorError,
  MyInvestorErrorKind,
  MyInvestorReader,
  ResolveFxRateSnapshotOptions,
} from "@worthline/pricing";
import { MyInvestorSyncError } from "@worthline/pricing";
import {
  hasSavedPassword,
  readMyInvestorCredentials,
  serializeMyInvestorCredentials,
} from "./myinvestor-credentials";
import {
  type MyInvestorDiscovery,
  parseMyInvestorDiscovery,
  readMyInvestorAccount,
  serializeMyInvestorDiscovery,
} from "./myinvestor-discovery";
import { resolveMyInvestorRates } from "./myinvestor-rates";
import {
  type MyInvestorSyncOutcome,
  type MyInvestorSyncStep,
  parseMyInvestorSyncOutcome,
  serializeMyInvestorSyncOutcome,
  serializeMyInvestorUnitsCheck,
} from "./myinvestor-sync-outcome";
import {
  carryTransferCostsFromBook,
  checkMyInvestorUnits,
  planMyInvestorSync,
  refreshMyInvestorDiscovery,
} from "./myinvestor-sync-plan";

const MYINVESTOR_ADAPTER = "myinvestor";

/** Logins per connection per day, button and cron together (decision 7). */
export const MYINVESTOR_DAILY_LOGINS = 10;
/** Password rejections in one day that lock the connection until the next. */
export const MYINVESTOR_REJECTIONS_TO_LOCK = 3;
/** The pause after a rejection with no reason (decision 7, decision 10). */
export const MYINVESTOR_PAUSE_HOURS = 24;
/**
 * How long a pass holds the connection at most. Longer than any pass: a pass that
 * is killed halfway (a serverless timeout) frees it when it expires.
 */
export const MYINVESTOR_LEASE_MINUTES = 10;
/** How often the button looks again at a pass it is waiting for. */
export const MYINVESTOR_WAIT_POLL_MS = 1_500;

/** The reason the periodic sync is stopped until a pass works again. */
export const MYINVESTOR_STOPPED_SMS = "sms_required";

export type MyInvestorSyncTrigger = "manual" | "cron";

/** What a pass needs of the client. */
export type MyInvestorSyncClient = Pick<
  MyInvestorClient,
  "loginWithKnownDevice" | "reader"
>;

export type MyInvestorSyncStore = {
  connectedSources: Pick<
    WorthlineStore["connectedSources"],
    | "readSource"
    | "readDiscovery"
    | "saveDiscovery"
    | "readLinks"
    | "claimSyncLease"
    | "setSyncStep"
    | "releaseSyncLease"
    | "reserveSyncLogin"
    | "recordPasswordRejection"
    | "updateSyncState"
    | "readSyncState"
    | "purgeSyncAttempts"
  >;
  command: Pick<WorthlineStore["command"], "syncConnectedHoldings">;
  operations: Pick<WorthlineStore["operations"], "readHoldingLedgers">;
};

export interface MyInvestorSyncDeps {
  store: MyInvestorSyncStore;
  clientFor: (deviceId: string) => MyInvestorSyncClient;
  /** The wall clock, read as the pass goes: a wait spans several instants. */
  now: () => string;
  /** The app's calendar day (UTC), the day the logins are counted in. */
  today: () => string;
  sleep: (ms: number) => Promise<void>;
  /** Swaps the ECB the orders in another currency are converted with (tests). */
  fx?: ResolveFxRateSnapshotOptions;
}

export interface MyInvestorSyncInput {
  sourceId: string;
  trigger: MyInvestorSyncTrigger;
  /** The username and password typed now, when none is saved. Used once, never kept. */
  typed: MyInvestorCredentials | null;
  /** «Resincronizar todo»: read the whole history again, from 2000-01-01. */
  fullHistory?: boolean;
}

/** What a failed attempt names of its failure, for the log and the maintainer alert. */
export type MyInvestorSyncFailure = Pick<MyInvestorError, "kind" | "step" | "httpStatus">;

export type MyInvestorSyncResult =
  /** A pass ran — this one, or the one the button waited for. */
  | {
      status: "done";
      outcome: MyInvestorSyncOutcome;
      waited: boolean;
      /** The failure MyInvestor answered, when this pass met one. Words, never data. */
      failure?: MyInvestorSyncFailure | null;
    }
  /** The button, while the connection is paused or locked. */
  | { status: "blocked"; reason: "rejected_no_reason" | "locked"; until: string }
  /** The button with no saved password and none typed. */
  | { status: "password_needed" }
  | { status: "not_found" }
  /** The cron leaves this connection alone. */
  | { status: "skipped"; reason: "no_password" | "stopped" | "paused" | "busy" };

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** The first instant of the day after `day` (UTC), when a lock of the day ends. */
function nextDayStart(day: string): string {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(start + 86_400_000).toISOString();
}

/** What a stored or failed pass says about a pause still running at `now`. */
function activePause(
  pausedUntil: string | null,
  lastOutcome: MyInvestorSyncOutcome | null,
  now: string,
): { reason: "rejected_no_reason" | "locked"; until: string } | null {
  if (pausedUntil === null || pausedUntil <= now) return null;
  return {
    reason: lastOutcome?.kind === "locked" ? "locked" : "rejected_no_reason",
    until: pausedUntil,
  };
}

/** Run one pass for one connection: the button's, the cron's or «Resincronizar todo». */
export async function runMyInvestorSync(
  deps: MyInvestorSyncDeps,
  input: MyInvestorSyncInput,
): Promise<MyInvestorSyncResult> {
  const sources = deps.store.connectedSources;
  const source = await sources.readSource(input.sourceId);
  if (!source || source.adapter !== MYINVESTOR_ADAPTER) return { status: "not_found" };
  const credentials = readMyInvestorCredentials(source.credentialsJson);
  if (!credentials) return { status: "not_found" };

  const state = await sources.readSyncState(input.sourceId);
  const pause = activePause(
    state?.pausedUntil ?? null,
    parseMyInvestorSyncOutcome(state?.lastOutcomeJson ?? null),
    deps.now(),
  );
  const saved = hasSavedPassword(credentials);
  if (input.trigger === "cron") {
    if (!saved) return { reason: "no_password", status: "skipped" };
    if (state?.stoppedReason) return { reason: "stopped", status: "skipped" };
    if (pause) return { reason: "paused", status: "skipped" };
  } else if (pause) {
    return { ...pause, status: "blocked" };
  }
  const login = saved
    ? { customerId: credentials.customerId, password: credentials.password }
    : input.typed;
  if (!login) return { status: "password_needed" };

  const startedAt = deps.now();
  const claim = await sources.claimSyncLease({
    now: startedAt,
    sourceId: input.sourceId,
    trigger: input.trigger,
    until: addMinutes(startedAt, MYINVESTOR_LEASE_MINUTES),
  });
  if (!claim.claimed) {
    if (input.trigger === "cron") return { reason: "busy", status: "skipped" };
    return waitForPass(deps, input.sourceId);
  }

  try {
    const { outcome, failure } = await pass(deps, input, {
      deviceId: credentials.deviceId,
      login,
      savedPassword: saved,
      startedAt,
    });
    return { failure, outcome, status: "done", waited: false };
  } finally {
    await sources.releaseSyncLease(input.sourceId);
  }
}

/**
 * The button found a pass in progress: wait for it, then answer with what it left.
 * Bounded by the lease: a pass that never finishes stops being waited for when its
 * lease expires.
 */
async function waitForPass(
  deps: MyInvestorSyncDeps,
  sourceId: string,
): Promise<MyInvestorSyncResult> {
  const rounds = Math.ceil((MYINVESTOR_LEASE_MINUTES * 60_000) / MYINVESTOR_WAIT_POLL_MS);
  for (let round = 0; round <= rounds; round += 1) {
    await deps.sleep(MYINVESTOR_WAIT_POLL_MS);
    const state = await deps.store.connectedSources.readSyncState(sourceId);
    if (state?.lease && state.lease.until > deps.now()) continue;
    const outcome = parseMyInvestorSyncOutcome(state?.lastOutcomeJson ?? null);
    return {
      outcome: outcome ?? { at: deps.now(), kind: "failed" },
      status: "done",
      waited: true,
    };
  }
  return { outcome: { at: deps.now(), kind: "failed" }, status: "done", waited: true };
}

/**
 * The row of the attempt log for a pass that ended in `outcome`: null error for a
 * good one; for a failed one, the error's kind (or `internal`, when it was not
 * MyInvestor's), the outcome, the step and the HTTP status.
 */
function attemptError(
  outcome: MyInvestorSyncOutcome,
  failure: MyInvestorSyncFailure | null,
): SyncRunError | null {
  if (outcome.kind === "ok") return null;
  return {
    code: failure?.kind ?? "internal",
    httpStatus: failure?.httpStatus ?? null,
    message: outcome.kind,
    retriable: failure?.kind === "network_or_waf",
    step: failure?.step ?? null,
  };
}

/** The pass itself, with the lease held. Records its outcome and its attempt before it returns. */
async function pass(
  deps: MyInvestorSyncDeps,
  input: MyInvestorSyncInput,
  connection: {
    deviceId: string;
    login: MyInvestorCredentials;
    savedPassword: boolean;
    startedAt: string;
  },
): Promise<{ outcome: MyInvestorSyncOutcome; failure: MyInvestorSyncFailure | null }> {
  const sources = deps.store.connectedSources;
  const { sourceId } = input;
  const day = asDateKey(deps.today());
  const step = (key: MyInvestorSyncStep) => sources.setSyncStep(sourceId, key);
  /** The pass's row of the attempt log, for an outcome reached now. */
  const attemptRow = (
    outcome: MyInvestorSyncOutcome,
    failure: MyInvestorSyncFailure | null,
  ) => ({
    error: attemptError(outcome, failure),
    finishedAt: deps.now(),
    startedAt: connection.startedAt,
    trigger: input.trigger,
  });
  /**
   * How a pass ends: its outcome on the state and, for a pass that asked
   * MyInvestor, its row of the attempt log, in ONE write (#1885) — the band and the
   * health rule read the two, and a half-written pass would set them apart.
   */
  const finishing =
    (failure: MyInvestorSyncFailure | null, attempted = true): Finish =>
    async (outcome, patch = {}) => {
      await sources.updateSyncState(
        sourceId,
        { ...patch, lastOutcomeJson: serializeMyInvestorSyncOutcome(outcome) },
        attempted ? attemptRow(outcome, failure) : undefined,
      );
      return outcome;
    };

  const reserved = await sources.reserveSyncLogin({
    cap: MYINVESTOR_DAILY_LOGINS,
    day,
    sourceId,
  });
  // The day's limit: MyInvestor is not asked, so it is no attempt.
  if (reserved === null) {
    const outcome = await finishing(null, false)({ at: deps.now(), kind: "limit" });
    return { failure: null, outcome };
  }

  const answeredFailure = async (error: MyInvestorError) => {
    const failure: MyInvestorSyncFailure = {
      httpStatus: error.httpStatus,
      kind: error.kind,
      step: error.step,
    };
    const outcome = await failed(
      deps,
      {
        ...connection,
        attempt: (rejected) => attemptRow(rejected, failure),
        day,
        finish: finishing(failure),
        sourceId,
      },
      error.kind,
    );
    return { failure, outcome };
  };

  await step("login");
  const client = deps.clientFor(connection.deviceId);
  const tokens = await client.loginWithKnownDevice(connection.login);
  if (!tokens.ok) return answeredFailure(tokens.error);

  try {
    const outcome = await readAndApply(
      deps,
      input,
      client.reader(tokens.value),
      step,
      finishing(null),
    );
    return { failure: null, outcome };
  } catch (error) {
    if (error instanceof MyInvestorSyncError) return answeredFailure(error.error);
    // Not MyInvestor's: a bug or the database. Kept as a failed pass and a failed
    // attempt so the band and the log say so, and thrown on so it is never swallowed.
    await finishing(null)({ at: deps.now(), kind: "failed" });
    throw error;
  }
}

/** Ends a pass with its outcome (and the patch of state that goes with it). */
type Finish = (
  outcome: MyInvestorSyncOutcome,
  patch?: Parameters<MyInvestorSyncStore["connectedSources"]["updateSyncState"]>[1],
) => Promise<MyInvestorSyncOutcome>;

/** Each error's action (ADR 0114 decision 7). */
async function failed(
  deps: MyInvestorSyncDeps,
  context: {
    sourceId: string;
    day: DateKey;
    deviceId: string;
    savedPassword: boolean;
    finish: Finish;
    /** The attempt's row, written with the rejection in its one transaction. */
    attempt: (
      outcome: MyInvestorSyncOutcome,
    ) => NonNullable<
      Parameters<
        MyInvestorSyncStore["connectedSources"]["recordPasswordRejection"]
      >[0]["attempt"]
    >;
  },
  kind: MyInvestorErrorKind,
): Promise<MyInvestorSyncOutcome> {
  const sources = deps.store.connectedSources;
  const at = deps.now();
  switch (kind) {
    case "password_rejected": {
      // Never retried on its own: a saved password goes at once, the device stays.
      // All of it in one transaction: deleted, counted, locked on the third and
      // written down, or none of it.
      const until = nextDayStart(context.day);
      const rejected: MyInvestorSyncOutcome = {
        at,
        forgotten: context.savedPassword,
        kind: "password_rejected",
      };
      const locked: MyInvestorSyncOutcome = { at, kind: "locked", until };
      const result = await sources.recordPasswordRejection({
        attempt: context.attempt(rejected),
        credentialsJson: context.savedPassword
          ? serializeMyInvestorCredentials({ deviceId: context.deviceId })
          : null,
        day: context.day,
        lockAfter: MYINVESTOR_REJECTIONS_TO_LOCK,
        lockedUntil: until,
        outcomeJson: {
          locked: serializeMyInvestorSyncOutcome(locked),
          rejected: serializeMyInvestorSyncOutcome(rejected),
        },
        sourceId: context.sourceId,
      });
      return result.locked ? locked : rejected;
    }
    case "rejected_no_reason": {
      const until = addMinutes(at, MYINVESTOR_PAUSE_HOURS * 60);
      return context.finish(
        { at, kind: "rejected_no_reason", until },
        { pausedUntil: until },
      );
    }
    case "sms_required":
      return context.finish(
        { at, kind: "sms_required" },
        { stoppedReason: MYINVESTOR_STOPPED_SMS },
      );
    case "network_or_waf":
      return context.finish({ at, kind: "network" });
    default:
      return context.finish({ at, kind: "failed" });
  }
}

/** The reads, the batch, the stored read and the units check of a good login. */
async function readAndApply(
  deps: MyInvestorSyncDeps,
  input: MyInvestorSyncInput,
  reader: MyInvestorReader,
  step: (key: MyInvestorSyncStep) => Promise<void>,
  finish: (
    outcome: MyInvestorSyncOutcome,
    patch?: Parameters<MyInvestorSyncStore["connectedSources"]["updateSyncState"]>[1],
  ) => Promise<MyInvestorSyncOutcome>,
): Promise<MyInvestorSyncOutcome> {
  const { store } = deps;
  const { sourceId } = input;
  const today = deps.today();

  const stored = await store.connectedSources.readDiscovery(sourceId);
  const previous: MyInvestorDiscovery | null = stored
    ? parseMyInvestorDiscovery(stored.payloadJson)
    : null;
  // The whole history when asked, or when there is no read to lay the window over:
  // a traspaso's cost is folded from its origin's whole ledger, never from 30 days.
  const fullHistory = input.fullHistory === true || previous === null;
  const { cursor, reads } = await readMyInvestorAccount(reader, today, {
    cursor: fullHistory ? null : previous.readOn,
    onStep: step,
  });

  await step("check");
  const discovery = refreshMyInvestorDiscovery(fullHistory ? null : previous, reads);
  const windowKeys = fullHistory
    ? null
    : new Set(
        reads.operations
          .filter((fact) => fact.payload.kind === "operation")
          .map((fact) => fact.key),
      );
  const links = await store.connectedSources.readLinks(sourceId);
  // An order in another currency is written in euros at the ECB rate of its day
  // (#1899); with no rate it waits for a later pass, and the rest goes on.
  const rates = await resolveMyInvestorRates(discovery, deps.fx);
  const plan = planMyInvestorSync(discovery, {
    cursor,
    links,
    rates,
    sourceId,
    windowKeys,
  });

  // A new traspaso's inherited cost travels from its origin's BOOK, answers to
  // #1882 included, never only from what the stored read can fold.
  const linkedAssets = plan.witnesses.map((witness) => witness.assetId);
  const before = await store.operations.readHoldingLedgers(linkedAssets);
  const books = new Map(
    [...before].map(([assetId, ledger]) => [assetId, ledger.operations]),
  );
  const facts = carryTransferCostsFromBook(plan.facts.facts, books);

  const { applied } = await store.command.syncConnectedHoldings({
    cashBalances: plan.cashBalances,
    facts: { cursor: plan.facts.cursor, facts },
    portfolioWitnesses: plan.portfolioWitnesses,
    sourceId,
    today,
  });

  // Every linked ledger in one read, not one round trip per holding.
  const ledgers = await store.operations.readHoldingLedgers(
    plan.witnesses.map((witness) => witness.assetId),
  );
  const bookUnits = new Map<string, DecimalString>();
  for (const witness of plan.witnesses) {
    bookUnits.set(
      witness.assetId,
      netUnitsFromOperations(ledgers.get(witness.assetId)?.operations ?? []),
    );
  }
  const mismatches = checkMyInvestorUnits(plan.witnesses, bookUnits);

  // A good pass is the last good sync: the stored read is replaced and stamped.
  await store.connectedSources.saveDiscovery({
    payloadJson: serializeMyInvestorDiscovery(discovery),
    readAt: deps.now(),
    readOn: discovery.readOn,
    sourceId,
  });
  return finish(
    {
      applied,
      at: deps.now(),
      kind: "ok",
      mismatches: mismatches.length,
      resynced: input.fullHistory === true,
    },
    {
      pausedUntil: null,
      stoppedReason: null,
      unitsCheckJson: serializeMyInvestorUnitsCheck(mismatches),
    },
  );
}

/** The cron's own seams: the client and the sleep, for the tests. */
export interface MyInvestorRefreshDeps {
  clientFor: ((deviceId: string) => MyInvestorSyncClient) | null;
  sleep?: (ms: number) => Promise<void>;
  /** The wall clock; the tests pin it. */
  now?: () => string;
}

/**
 * A failed pass as the maintainer alert reads it (#1755, #1885): the outcome, and
 * the step and HTTP status MyInvestor failed on when it answered one. Words, never
 * data.
 */
function cronFailureLine(
  outcome: MyInvestorSyncOutcome,
  failure: MyInvestorSyncFailure | null | undefined,
): string {
  if (!failure) return `MyInvestor: ${outcome.kind}`;
  const http = failure.httpStatus === null ? "" : `, HTTP ${failure.httpStatus}`;
  return `MyInvestor: ${outcome.kind} (${failure.step}${http})`;
}

/** The kinds a cron pass reports as a degradation (#1755): words, never data. */
const CRON_FAILURES: ReadonlySet<MyInvestorSyncOutcome["kind"]> = new Set([
  "password_rejected",
  "locked",
  "rejected_no_reason",
  "sms_required",
  "network",
  "failed",
  "limit",
]);

/**
 * The daily capture's MyInvestor phase (#1884), next to Binance and Numista: one
 * pass per connection with a saved password. The premium gate is the capture's own
 * (`shouldSyncConnectedSources`, ADR 0114 decision 2), which skips this phase for a
 * lapsed plan. A failed pass is reported by its kind; a throw is reported, never
 * swallowed, and never stops the capture. The capture's pinned instant is the
 * snapshot's, not the pass's: the pass runs on the wall clock.
 */
export async function runMyInvestorRefresh(
  store: WorthlineStore,
  _captureInstant: string,
  refreshDeps: MyInvestorRefreshDeps,
): Promise<{ errors: string[] }> {
  const { clientFor } = refreshDeps;
  if (!clientFor) return { errors: [] };
  const now = refreshDeps.now ?? (() => new Date().toISOString());
  const sources = (await store.connectedSources.listSources()).filter(
    (source) => source.adapter === MYINVESTOR_ADAPTER,
  );
  const errors: string[] = [];
  for (const source of sources) {
    try {
      // The log's 90 days hold also for a connection the cron passes over (#1885):
      // with no saved password it may make no attempt in months.
      await store.connectedSources.purgeSyncAttempts({ now: now(), sourceId: source.id });
      const result = await runMyInvestorSync(
        {
          clientFor,
          // The WALL clock, never the capture's pinned instant: a job drained hours
          // after it was enqueued would otherwise take a lease that already expired
          // to the button, and count its login on another day.
          now,
          sleep: refreshDeps.sleep ?? defaultSleep,
          store,
          today: () => now().slice(0, 10),
        },
        { sourceId: source.id, trigger: "cron", typed: null },
      );
      if (result.status === "done" && CRON_FAILURES.has(result.outcome.kind)) {
        errors.push(cronFailureLine(result.outcome, result.failure));
      }
    } catch (error) {
      errors.push(
        `MyInvestor: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { errors };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A clock that starts at `startIso` and moves with the wall clock. */
export function elapsedClock(startIso: string): () => string {
  const origin = Date.now();
  const start = Date.parse(startIso);
  return () => new Date(start + (Date.now() - origin)).toISOString();
}

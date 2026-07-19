/**
 * Common connector conformance suite (PRD #1000 S2, decision #888).
 *
 * The shared battery every connector must pass — idempotency, duplicates,
 * retries, freshness, unlink, atomicity — expressed once against an in-memory
 * application host so a new adapter earns its correctness by wiring a fake and
 * calling {@link describeConnectorConformance}, not by re-litigating these
 * invariants per provider (the failure mode Sure hit, #2546).
 *
 * The host ({@link createInMemoryConnectorHost}) is a faithful, transactional
 * stand-in for the application side of the port: a rollback-on-throw
 * `UnitOfWork`, a fact ledger, the dedup `seen` ledger, the resumption cursor,
 * and a ripple log. It drives the real `reconcileFacts` + `commitReconciled`, so
 * the suite tests the actual port, not a re-implementation.
 */

import type {
  ConnectorAdapter,
  ConnectorCursor,
  FactKey,
  FetchCapabilityKind,
  ReferenceEvent,
} from "@worthline/domain";
import { assertCapability, reconcileFacts } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { type ConnectorCommitResult, commitReconciled } from "./connector-commit";
import type { CommandResult, UnitOfWork } from "./types";

const TODAY = "2026-07-19";
const SOURCE_ID = "src-1";

/** One fact the host persisted, with the batch that carried it. */
interface AppliedFact {
  batchId: string;
  key: FactKey;
  dateKey: string;
}

/** Options for one driven sync cycle. */
export interface RunSyncOptions {
  /**
   * Fetch from this cursor instead of the host's stored one — lets a test replay
   * an overlapping window the source already served.
   */
  cursor?: ConnectorCursor | null;
  /** Throw while persisting the fact with this key, to test atomic rollback. */
  failPersistOnKey?: FactKey;
}

/** The in-memory application host the conformance suite drives the port through. */
export interface InMemoryConnectorHost {
  /** Fetch → reconcile → commit one batch from `adapter`, returning the result. */
  runSync: (
    adapter: ConnectorAdapter,
    capability: FetchCapabilityKind,
    options?: RunSyncOptions,
  ) => Promise<CommandResult<ConnectorCommitResult>>;
  /** Forget the connector's dedup ledger + cursor (an unlink). */
  unlink: () => void;
  appliedFacts: () => AppliedFact[];
  appliedKeys: () => FactKey[];
  seenSize: () => number;
  cursor: () => ConnectorCursor | null;
  batchCount: () => number;
  rippleFloors: () => string[];
}

/** Build a fresh in-memory host with an empty ledger. */
export function createInMemoryConnectorHost(): InMemoryConnectorHost {
  let applied: AppliedFact[] = [];
  let seen = new Set<FactKey>();
  let cursor: ConnectorCursor | null = null;
  let batches: string[] = [];
  let rippleFloors: string[] = [];
  let nextBatch = 0;

  const uow: UnitOfWork = {
    createFactBatch: async () => {
      nextBatch += 1;
      const id = `batch-${nextBatch}`;
      batches = [...batches, id];
      return id;
    },
    transaction: async (work) => {
      // Snapshot every mutable field so a throw rolls facts, batch, cursor, and
      // dedup ledger back together — the atomicity the port promises.
      const snapshot = {
        applied,
        seen: new Set(seen),
        cursor,
        batches,
        rippleFloors,
        nextBatch,
      };
      try {
        return await work();
      } catch (error) {
        applied = snapshot.applied;
        seen = snapshot.seen;
        cursor = snapshot.cursor;
        batches = snapshot.batches;
        rippleFloors = snapshot.rippleFloors;
        nextBatch = snapshot.nextBatch;
        throw error;
      }
    },
  };

  return {
    runSync: async (adapter, capability, options) => {
      // The application gates on the declared capability before touching the
      // adapter — a connector never runs a path it did not advertise (CONTEXT).
      assertCapability(adapter, capability);
      const fromCursor = options?.cursor !== undefined ? options.cursor : cursor;
      const batch = await adapter.fetch({ capability, cursor: fromCursor });
      const plan = reconcileFacts(batch, seen);
      return commitReconciled({
        plan,
        today: TODAY,
        connectedSourceId: SOURCE_ID,
        persistFact: async (fact, batchId) => {
          if (options?.failPersistOnKey === fact.key) {
            throw new Error(`persist failed for ${fact.key}`);
          }
          applied = [...applied, { batchId, key: fact.key, dateKey: fact.dateKey }];
        },
        ripple: async (fromDateKey) => {
          rippleFloors = [...rippleFloors, fromDateKey];
        },
        recordCommit: async ({ cursor: nextCursor, appliedKeys }) => {
          cursor = nextCursor;
          seen = new Set(seen);
          for (const key of appliedKeys) seen.add(key);
        },
        uow,
      });
    },
    unlink: () => {
      seen = new Set();
      cursor = null;
    },
    appliedFacts: () => [...applied],
    appliedKeys: () => applied.map((fact) => fact.key),
    seenSize: () => seen.size,
    cursor: () => cursor,
    batchCount: () => batches.length,
    rippleFloors: () => [...rippleFloors],
  };
}

/**
 * A connector, plus the observable state and fault injection the conformance
 * suite needs. Any adapter that wants to run the suite provides a fake honoring
 * this contract, built from a list of {@link ReferenceEvent}s — see
 * {@link @worthline/domain#createReferenceAdapter} for the canonical one.
 */
export interface ConformanceAdapterHandle {
  adapter: ConnectorAdapter;
  isDisconnected: () => boolean;
  fetchCount: () => number;
  failNextFetch: (message?: string) => void;
}

/** Builds a connector handle over a fixed event ledger. */
export type ConformanceAdapterFactory = (
  events: readonly ReferenceEvent[],
) => ConformanceAdapterHandle;

const BASIC_LEDGER: readonly ReferenceEvent[] = [
  { key: "evt-a", dateKey: "2026-03-01", label: "A" },
  { key: "evt-b", dateKey: "2026-04-01", label: "B" },
  { key: "evt-c", dateKey: "2026-05-01", label: "C" },
];

// An overlapping page: the source serves `evt-a` twice in one window.
const DUPLICATE_LEDGER: readonly ReferenceEvent[] = [
  { key: "evt-a", dateKey: "2026-03-01", label: "A" },
  { key: "evt-a", dateKey: "2026-03-01", label: "A (again)" },
  { key: "evt-c", dateKey: "2026-05-01", label: "C" },
];

/**
 * Register the common conformance suite for a connector. Pass a factory that
 * builds the adapter (and its observable handle) over a supplied event ledger.
 * The suite drives the real port end-to-end through an in-memory host.
 */
export function describeConnectorConformance(
  name: string,
  makeAdapter: ConformanceAdapterFactory,
  capability: FetchCapabilityKind = "fetch_transactions",
): void {
  describe(`connector conformance: ${name}`, () => {
    test("idempotency — re-serving an already-applied window applies nothing", async () => {
      const host = createInMemoryConnectorHost();
      const { adapter } = makeAdapter(BASIC_LEDGER);

      const first = await host.runSync(adapter, capability);
      expect(first.ok).toBe(true);
      expect(host.appliedKeys()).toEqual(["evt-a", "evt-b", "evt-c"]);

      // The source resends the whole window (cursor rewound); reconciliation
      // against the dedup ledger drops all of it.
      const replay = await host.runSync(adapter, capability, { cursor: null });
      expect(replay.ok && replay.value.applied).toBe(0);
      expect(host.appliedKeys()).toEqual(["evt-a", "evt-b", "evt-c"]);
      expect(host.seenSize()).toBe(3);
    });

    test("duplicates — a key repeated within one batch is applied once", async () => {
      const host = createInMemoryConnectorHost();
      const { adapter } = makeAdapter(DUPLICATE_LEDGER);

      const result = await host.runSync(adapter, capability);
      expect(result.ok && result.value.applied).toBe(2);
      expect(host.appliedKeys()).toEqual(["evt-a", "evt-c"]);
    });

    test("retries — a transient fetch failure and a mid-commit failure both re-run clean", async () => {
      const host = createInMemoryConnectorHost();
      const handle = makeAdapter(BASIC_LEDGER);

      // A transient network error surfaces as a rejected fetch; nothing is touched.
      handle.failNextFetch();
      await expect(host.runSync(handle.adapter, capability)).rejects.toThrow();
      expect(host.appliedKeys()).toEqual([]);
      expect(host.cursor()).toBeNull();

      // A mid-commit failure rolls facts, batch, cursor, and ledger back together.
      const failed = await host.runSync(handle.adapter, capability, {
        failPersistOnKey: "evt-b",
      });
      expect(failed.ok).toBe(false);
      expect(host.appliedKeys()).toEqual([]);
      expect(host.seenSize()).toBe(0);
      expect(host.cursor()).toBeNull();
      expect(host.batchCount()).toBe(0);

      // The retry, with no injected fault, applies each fact exactly once.
      const retry = await host.runSync(handle.adapter, capability);
      expect(retry.ok && retry.value.applied).toBe(3);
      expect(host.appliedKeys()).toEqual(["evt-a", "evt-b", "evt-c"]);
    });

    test("freshness — a no-op sync still commits a batch and carries the cursor", async () => {
      const host = createInMemoryConnectorHost();
      const { adapter } = makeAdapter(BASIC_LEDGER);

      await host.runSync(adapter, capability);
      const cursorAfterFirst = host.cursor();
      const batchesAfterFirst = host.batchCount();

      const noop = await host.runSync(adapter, capability);
      expect(noop.ok && noop.value.applied).toBe(0);
      expect(host.cursor()).toBe(cursorAfterFirst);
      // A sync happened even with nothing to apply: one more batch, no new facts.
      expect(host.batchCount()).toBe(batchesAfterFirst + 1);
      expect(host.appliedKeys()).toEqual(["evt-a", "evt-b", "evt-c"]);
    });

    test("unlink — disconnect tears down and clears the connector's own state", async () => {
      const host = createInMemoryConnectorHost();
      const handle = makeAdapter(BASIC_LEDGER);

      await host.runSync(handle.adapter, capability);
      expect(host.seenSize()).toBe(3);

      assertCapability(handle.adapter, "disconnect");
      await handle.adapter.disconnect?.();
      host.unlink();

      expect(handle.isDisconnected()).toBe(true);
      expect(host.seenSize()).toBe(0);
      expect(host.cursor()).toBeNull();

      // A reconnect re-syncs from scratch against the now-empty ledger.
      const reconnect = await host.runSync(handle.adapter, capability, {
        cursor: null,
      });
      expect(reconnect.ok && reconnect.value.applied).toBe(3);
    });

    test("atomicity — one successful commit is one batch and one ripple", async () => {
      const host = createInMemoryConnectorHost();
      const { adapter } = makeAdapter(BASIC_LEDGER);

      const result = await host.runSync(adapter, capability);
      expect(result.ok).toBe(true);
      expect(host.batchCount()).toBe(1);
      // Exactly one ripple, floored at the earliest applied date (ADR 0020/0062).
      expect(host.rippleFloors()).toEqual(["2026-03-01"]);
    });
  });
}

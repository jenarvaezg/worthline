/**
 * Reference in-memory connector adapter (PRD #1000 S2, decision #888).
 *
 * A pure, deterministic {@link ConnectorAdapter} the conformance suite runs
 * against — and the worked example a real adapter (universal statement, IBKR, …)
 * is read against. It mirrors a fixed **source ledger** of events: `fetch`
 * returns every event after the given cursor, and the cursor is simply how many
 * events the source has emitted so far (`"3"` = "you have seen the first three").
 *
 * That sequence cursor gives the port's guarantees naturally, with no persistence
 * of its own:
 * - resuming from an OLD cursor re-emits the same events (retry / overlap safe);
 * - resuming from the LATEST cursor returns an empty batch with the cursor
 *   unchanged (the freshness signal — a sync happened, nothing new);
 * - an event whose `key` repeats an earlier one models an overlapping page.
 *
 * It touches no database and holds no repositories (CONTEXT: an adapter "never
 * writes the workspace or receives its repositories"). Network failures are
 * simulated by {@link ReferenceAdapterHandle.failNextFetch}.
 */

import type {
  ConnectorAccount,
  ConnectorAdapter,
  ConnectorCapability,
  FactKey,
  NormalizedBatch,
} from "./connector-port";

/** One event in the reference source's fixed ledger. */
export interface ReferenceEvent {
  /** The source's stable dedup key for this event. Repeat one to model an
   *  overlapping page (two observations of the same underlying event). */
  key: FactKey;
  /** The calendar date (`YYYY-MM-DD`) the event's fact lands on. */
  dateKey: string;
  /** A human label, carried through to the payload for assertions. */
  label: string;
}

/** The opaque payload the reference adapter emits for each fact. */
export interface ReferencePayload {
  /** 1-based position in the source ledger — a stable order for the persister. */
  seq: number;
  key: FactKey;
  label: string;
}

/** Options for {@link createReferenceAdapter}. */
export interface ReferenceAdapterOptions {
  id?: string;
  events: readonly ReferenceEvent[];
  /** Defaults to the full set (all fetch kinds + discover + disconnect). */
  capabilities?: readonly ConnectorCapability[];
  accounts?: readonly ConnectorAccount[];
}

const ALL_CAPABILITIES: readonly ConnectorCapability[] = [
  { kind: "discover_accounts" },
  { kind: "fetch_transactions" },
  { kind: "fetch_positions" },
  { kind: "fetch_balances" },
  { kind: "disconnect" },
];

/** Test-side handle onto a reference adapter's observable state. */
export interface ReferenceAdapterHandle {
  adapter: ConnectorAdapter<ReferencePayload>;
  /** Whether `disconnect()` has been called. */
  isDisconnected(): boolean;
  /** How many times `fetch()` has been invoked. */
  fetchCount(): number;
  /** Make the next `fetch()` reject once, simulating a transient network error. */
  failNextFetch(message?: string): void;
}

function parseCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

/**
 * Build a reference adapter over a fixed ledger of `events`. Returns a {@link
 * ReferenceAdapterHandle} exposing both the adapter and the observable state the
 * conformance suite asserts on (disconnected flag, fetch count, fault injection).
 */
export function createReferenceAdapter(
  options: ReferenceAdapterOptions,
): ReferenceAdapterHandle {
  const id = options.id ?? "reference";
  const events = [...options.events];
  const capabilities = [...(options.capabilities ?? ALL_CAPABILITIES)];
  const accounts = [
    ...(options.accounts ?? [{ externalId: "acct-1", label: "Reference account" }]),
  ];

  let disconnected = false;
  let fetchCount = 0;
  let pendingFailure: string | null = null;

  const adapter: ConnectorAdapter<ReferencePayload> = {
    id,
    capabilities,
    discoverAccounts: async () => accounts.map((account) => ({ ...account })),
    fetch: async (request): Promise<NormalizedBatch<ReferencePayload>> => {
      fetchCount += 1;
      if (pendingFailure !== null) {
        const message = pendingFailure;
        pendingFailure = null;
        throw new Error(message);
      }
      const from = parseCursor(request.cursor);
      const facts = events.slice(from).map((event, offset) => {
        const seq = from + offset + 1;
        return {
          key: event.key,
          dateKey: event.dateKey,
          payload: { seq, key: event.key, label: event.label },
        };
      });
      // The cursor advances to the ledger length even when the slice is empty, so
      // a no-op sync still reports freshness.
      return { facts, cursor: String(events.length) };
    },
    disconnect: async () => {
      disconnected = true;
    },
  };

  return {
    adapter,
    isDisconnected: () => disconnected,
    fetchCount: () => fetchCount,
    failNextFetch: (message = "simulated network failure") => {
      pendingFailure = message;
    },
  };
}

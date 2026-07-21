/**
 * Universal statement connector adapter (PRD #1000 S3, decision #888, ADR 0066).
 *
 * The FIRST real {@link ConnectorAdapter} — the one that proves the port carries a
 * genuinely different feed than the reference adapter's incremental sequence. A
 * broker statement is a **one-shot file feed**: a parsed file presents its whole
 * set of dated facts at once, there is no window to page through. So this adapter
 * models resumption with a **content token** instead of a sequence counter:
 *
 * - `fetch` from any cursor that is NOT this file's token re-serves every parsed
 *   row (a fresh upload, or a re-upload after an unlink) — reconciliation against
 *   the dedup ledger is what stops an overlapping second statement from
 *   double-applying the rows the two files share;
 * - `fetch` from a cursor that EQUALS the token returns an empty batch with the
 *   token unchanged — the freshness signal: "this exact content was already
 *   processed, nothing new".
 *
 * It is pure: it holds the already-normalized rows the caller parsed and does its
 * own (trivial) "I/O" over them. It touches no database and holds no repositories
 * (CONTEXT: an adapter "never writes the workspace or receives its repositories").
 * The application maps the opaque `payload` to a dated-fact family at commit time
 * and drives {@link reconcileFacts} + `commitReconciled`; this adapter never does.
 *
 * The caller builds it from rows it already normalized to {@link NormalizedFact}s
 * (stable dedup `key`, calendar `dateKey`, opaque `payload`) — see the app-side
 * mapping from extracted statement rows. Feeding the conformance suite is the same
 * shape: map its {@link ReferenceEvent}s to rows.
 */

import type {
  ConnectorAdapter,
  ConnectorCapability,
  NormalizedBatch,
  NormalizedFact,
} from "./connector-port";

/** Options for {@link createStatementConnectorAdapter}. */
export interface StatementAdapterOptions<TPayload> {
  id?: string;
  /** The already-normalized rows this statement presents, in file order. */
  rows: readonly NormalizedFact<TPayload>[];
  /** Defaults to `fetch_transactions` + `disconnect` (a file of dated movements). */
  capabilities?: readonly ConnectorCapability[];
}

/** Test-side handle onto a statement adapter's observable state. */
export interface StatementAdapterHandle<TPayload = unknown> {
  adapter: ConnectorAdapter<TPayload>;
  /** Whether `disconnect()` has been called (the file link was torn down). */
  isDisconnected(): boolean;
  /** How many times `fetch()` has been invoked. */
  fetchCount(): number;
  /** Make the next `fetch()` reject once, simulating a transient parse/read error. */
  failNextFetch(message?: string): void;
}

const DEFAULT_CAPABILITIES: readonly ConnectorCapability[] = [
  { kind: "fetch_transactions" },
  { kind: "disconnect" },
];

/**
 * A stable, content-derived resumption token for a fixed set of rows (FNV-1a over
 * each row's `key` and `dateKey`). Deterministic and order-sensitive: the same
 * parsed file always yields the same token, a different file a different one. Never
 * derived from wall-clock time, so it survives replay (no `Date`/`Math.random`).
 */
export function statementContentToken<TPayload>(
  rows: readonly NormalizedFact<TPayload>[],
): string {
  let hash = 0x811c9dc5;
  for (const row of rows) {
    const material = `${row.key} ${row.dateKey} `;
    for (let index = 0; index < material.length; index += 1) {
      hash ^= material.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Build a universal-statement adapter over a fixed set of already-normalized
 * `rows`. Returns a {@link StatementAdapterHandle} exposing the adapter and the
 * observable state the conformance suite asserts on (disconnected flag, fetch
 * count, fault injection) — the same handle shape as the reference adapter.
 */
export function createStatementConnectorAdapter<TPayload>(
  options: StatementAdapterOptions<TPayload>,
): StatementAdapterHandle<TPayload> {
  const id = options.id ?? "universal-statement";
  const rows = [...options.rows];
  const capabilities = [...(options.capabilities ?? DEFAULT_CAPABILITIES)];
  const token = statementContentToken(rows);

  let disconnected = false;
  let fetchCount = 0;
  let pendingFailure: string | null = null;

  const adapter: ConnectorAdapter<TPayload> = {
    id,
    capabilities,
    fetch: async (request): Promise<NormalizedBatch<TPayload>> => {
      fetchCount += 1;
      if (pendingFailure !== null) {
        const message = pendingFailure;
        pendingFailure = null;
        throw new Error(message);
      }
      // Already processed this exact content: a no-op sync that still reports the
      // token as the freshness signal.
      if (request.cursor === token) {
        return { facts: [], cursor: token };
      }
      // A fresh (or re-served) file: present every row; the application's dedup
      // ledger drops any this source already applied.
      return { facts: rows.map((row) => ({ ...row })), cursor: token };
    },
    disconnect: async () => {
      disconnected = true;
    },
  };

  return {
    adapter,
    isDisconnected: () => disconnected,
    fetchCount: () => fetchCount,
    failNextFetch: (message = "simulated statement read failure") => {
      pendingFailure = message;
    },
  };
}

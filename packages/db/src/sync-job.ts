import type { SourcePositionInput } from "./connected-source-store";
import type { SyncRunError, SyncTrigger } from "./sync-run-store";

/**
 * The generic sync-job contract + its SYNCHRONOUS executor (PRD #999 S2, #1062).
 *
 * S1 (#1061) wired the observable `sync_run` straight into the source-specific
 * `syncConnectedSource` path. S2 generalizes that wiring into ONE reusable
 * entry point — {@link SyncJobExecutor.runSyncJob} — through which any kind of
 * sync work routes, still IN-PROCESS with no durability. The durable side (a
 * `job` table in the control plane, leases, persistent retries) is S3's job
 * (#887, #1063); a transport-swappable queue over this SAME contract lands there.
 *
 * What S2 owns:
 *   - a typed job DESCRIPTOR: `kind`, `dedupeKey`, and a kind-tagged payload;
 *   - a typed, retriable-classified ERROR (identical shape to S1's
 *     {@link SyncRunError}) so a future queue can decide re-enqueue without
 *     re-parsing a free-text message;
 *   - a single {@link SyncJobExecutor.runSyncJob} that dispatches by `kind` to a
 *     registered handler and applies SINGLE-FLIGHT by `dedupeKey` (the same
 *     concept as S1's per-source guard, now lifted to the job level);
 *   - `source-sync` re-cabled through it (behavior-equivalent to S1).
 *
 * `daily-capture` is admitted by the contract's SHAPE only — its real wiring is
 * S4 (#1064). Future kinds (backfills, document ingestion — #888/#851) are out of
 * v1; the contract just leaves room for them.
 */

/**
 * The job kinds v1 recognizes. `source-sync` executes in S2; `daily-capture` is
 * typed here so the contract admits it, but its handler is registered in S4.
 */
export type SyncJobKind = "source-sync" | "daily-capture";

/**
 * A structured, retriable-classified job failure. Same shape as S1's
 * {@link SyncRunError} (`{ code, message, retriable }`), re-exported under the
 * job vocabulary so the executor and the future queue speak one error language.
 */
export type SyncJobError = SyncRunError;

/** Payload for a connected-source sync (the S1 `syncConnectedSource` inputs). */
export interface SourceSyncJobPayload {
  sourceId: string;
  positions: SourcePositionInput[];
  syncedAt: string;
  trigger: SyncTrigger;
}

/**
 * Payload for the fleet-wide daily capture (S4 #1064). The pass-qualified run key
 * doubles as the `dedupeKey`; `now` is the enqueue-time wall clock, pinned so the
 * worker's capture derives the SAME date/run-key/snapshot instant it deduped on —
 * even if it drains after the 15:00 UTC pass cutoff or past midnight. Without a
 * pinned `now`, a delayed drain would recompute a different run key than the one
 * the enqueue single-flighted on, and the idempotency guard would stop composing.
 */
export interface DailyCaptureJobPayload {
  /** Pass-qualified run key (`YYYY-MM-DD:am|pm`, #895) — the idempotency handle. */
  runKey: string;
  /** Enqueue-time wall clock (ISO) — the intended capture instant, never the drain time. */
  now: string;
}

/** The payload carried by each {@link SyncJobKind}. */
export interface SyncJobPayloadByKind {
  "source-sync": SourceSyncJobPayload;
  "daily-capture": DailyCaptureJobPayload;
}

/**
 * A job descriptor: the WHAT (kind + payload) plus the `dedupeKey` that scopes
 * single-flight. Two descriptors sharing a `dedupeKey` never run overlapped.
 */
export type SyncJobDescriptor = {
  [K in SyncJobKind]: {
    kind: K;
    /** Single-flight key: a job whose key is already in flight is skipped. */
    dedupeKey: string;
    payload: SyncJobPayloadByKind[K];
  };
}[SyncJobKind];

/** Why a job did not run its work. */
export type SyncJobSkipReason =
  /** Single-flight: a job with the same `dedupeKey` was already in flight. */
  | "in-flight"
  /** The handler had nothing to do (e.g. S1's in-flight `sync_run` guard). */
  | "no-op";

/**
 * The outcome of a {@link SyncJobExecutor.runSyncJob} call. NEVER a thrown
 * exception for a job failure — the failure is captured as a typed `error` so a
 * future queue can inspect `retriable` uniformly. `cause` carries the original
 * thrown value ONLY so a synchronous caller can rethrow it verbatim (preserving
 * pre-S2 behavior); the durable queue ignores it.
 */
export type SyncJobResult =
  | { status: "ok" }
  | { status: "skipped"; reason: SyncJobSkipReason }
  | { status: "error"; error: SyncJobError; cause: unknown };

/**
 * Build a typed {@link SyncJobError} from a thrown value, normalizing the
 * `Error | unknown` message extraction that every failure site would otherwise
 * repeat. The caller supplies the `code` + retriable classification (both are a
 * per-site policy decision, never derivable from the cause).
 */
export function syncJobErrorFromCause(
  cause: unknown,
  policy: { code: string; retriable: boolean },
): SyncJobError {
  return {
    code: policy.code,
    message: cause instanceof Error ? cause.message : String(cause),
    retriable: policy.retriable,
  };
}

/**
 * Single-flight dedupe key for one source's sync (S1's per-source guard, lifted to
 * the job level). Two `source-sync` descriptors for the same source share this key,
 * so the queue never runs them overlapped.
 */
export function sourceSyncDedupeKey(sourceId: string): string {
  return `source-sync:${sourceId}`;
}

/**
 * Build a connected-source sync descriptor from its raw params (connect / manual /
 * cron). Centralizes the `dedupeKey` construction so every enqueue site — the
 * per-workspace seam and the app-edge triggers (S4) — agrees on one key shape.
 */
export function sourceSyncDescriptor(payload: SourceSyncJobPayload): SyncJobDescriptor {
  return {
    dedupeKey: sourceSyncDedupeKey(payload.sourceId),
    kind: "source-sync",
    payload,
  };
}

/**
 * The pass-qualified daily-capture run key (`YYYY-MM-DD:am|pm`, #895): the UTC date
 * plus an `am`/`pm` marker split at 15:00 UTC, so the ≈09:00 provisional and ≈21:00
 * close passes finalize independently while accidental double-triggers within a
 * single pass still collapse. It doubles as the job's `dedupeKey` AND the
 * idempotency handle inside `runDailyCapture` — computed ONCE at enqueue and carried
 * in the payload so a worker draining later uses the same key the enqueue deduped
 * on (see {@link DailyCaptureJobPayload}).
 */
export function dailyCaptureRunKey(nowIso: string): string {
  const dateKey = nowIso.slice(0, 10);
  const hour = Number(nowIso.slice(11, 13));
  const pass = Number.isFinite(hour) && hour < 15 ? "am" : "pm";
  return `${dateKey}:${pass}`;
}

/**
 * Build the fleet-wide daily-capture descriptor, pinning the enqueue-time `now` and
 * deriving the pass-qualified run key from it. The run key is both the `dedupeKey`
 * (single-flight per pass) and the payload's idempotency handle.
 */
export function dailyCaptureDescriptor(nowIso: string): SyncJobDescriptor {
  const runKey = dailyCaptureRunKey(nowIso);
  return { dedupeKey: runKey, kind: "daily-capture", payload: { now: nowIso, runKey } };
}

/** A per-kind unit of work. Runs synchronously and reports a typed outcome. */
export interface SyncJobHandler<K extends SyncJobKind = SyncJobKind> {
  run(payload: SyncJobPayloadByKind[K]): Promise<SyncJobResult>;
}

/** The registered handlers, at most one per kind. Unregistered kinds throw. */
export type SyncJobHandlers = {
  [K in SyncJobKind]?: SyncJobHandler<K>;
};

export interface SyncJobExecutor {
  /**
   * Run one job synchronously and report its typed outcome. Enforces
   * single-flight by `dedupeKey`: if a job with the same key is already in
   * flight, this one is skipped (`{ status: "skipped", reason: "in-flight" }`)
   * rather than run overlapped — the same no-storm guarantee as S1's per-source
   * guard, lifted to the job level. Never throws for a job FAILURE (that is a
   * typed `error` result); throws only on a programming error (no handler
   * registered for the kind).
   */
  runSyncJob(descriptor: SyncJobDescriptor): Promise<SyncJobResult>;
}

/**
 * Build the synchronous, in-process job executor over a handler registry. The
 * executor is deliberately kind-agnostic: it owns dispatch + single-flight and
 * nothing else, so S3/S4 can register more handlers (or wrap it in a durable
 * queue) without touching this core.
 */
export function createSyncJobExecutor(handlers: SyncJobHandlers): SyncJobExecutor {
  // In-process single-flight: the set of `dedupeKey`s with a job in flight RIGHT
  // NOW. This is the S2 (no-durability) analogue of S1's per-source guard — it
  // dedupes concurrent calls within one process/store lifetime. Cross-process
  // durability (a real dedupe over a `job` table + leases) is S3 (#887). For
  // `source-sync` the handler ALSO keeps S1's DB-level `sync_run` in-flight guard,
  // which additionally covers a run left dangling by a hard crash.
  const inFlight = new Set<string>();

  return {
    runSyncJob: async (descriptor) => {
      const { dedupeKey, kind } = descriptor;

      // Check-and-claim with NO await in between, so two concurrent callers can
      // never both pass the guard: the second sees the key and skips.
      if (inFlight.has(dedupeKey)) {
        return { reason: "in-flight", status: "skipped" };
      }

      const handler = handlers[kind];
      if (!handler) {
        throw new Error(`No sync-job handler registered for kind "${kind}".`);
      }

      inFlight.add(dedupeKey);
      try {
        // The descriptor union correlates `kind`↔`payload`, but TypeScript cannot
        // carry that correlation onto the separately-indexed `handler`, so this
        // one dispatch-boundary cast stands in for it. The public types stay sound.
        // Called on the handler (not a detached reference) so a handler relying on
        // `this` still binds correctly.
        return await (handler as SyncJobHandler).run(descriptor.payload);
      } catch (cause) {
        // A handler is expected to CAPTURE its own failures as a typed `error`
        // result (source-sync does). An uncaught throw is a defect in the handler;
        // normalize it to a non-retriable typed error so `runSyncJob` keeps its
        // "never throws for a job outcome" contract and the queue still sees a
        // typed result.
        return {
          cause,
          error: syncJobErrorFromCause(cause, {
            code: "sync_job_handler_threw",
            retriable: false,
          }),
          status: "error",
        };
      } finally {
        inFlight.delete(dedupeKey);
      }
    },
  };
}

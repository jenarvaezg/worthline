import { randomUUID } from "node:crypto";

import type { Client } from "@libsql/client";
import type {
  CreateGlobalExposureProfileInput,
  GlobalExposureProfile,
  GlobalExposureProfileBreakdowns,
  GlobalExposureProfileIdentity,
  InvestmentPriceProvider,
  RawGlobalExposureProfileIdentityInput,
  UpdateGlobalExposureProfileInput,
} from "@worthline/domain";
import {
  createValidatedGlobalExposureProfileInput,
  globalExposureProfileIdentityKey,
  resolveGlobalExposureProfileIdentity,
  validateGlobalExposureProfileContent,
} from "@worthline/domain";

import { migrateControlPlane } from "./control-plane-migrate";
import { trialEndsAtFrom, type WorkspaceEntitlement } from "./entitlements";
import { type LibsqlUrlTarget, openLibsqlClient } from "./libsql-client";

/**
 * The control plane (ADR 0030). A single small libSQL database — separate from
 * every per-workspace database — that maps **users** → **workspaces** →
 * **grants**. It is the only place that knows which workspace a signed-in user
 * owns; each workspace database itself still holds exactly one `id = 'default'`
 * row and knows nothing of users. Provision-on-first-login (see provisioner.ts)
 * writes the workspace + grant rows here.
 */

export interface ControlPlaneUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface ControlPlaneWorkspace {
  id: string;
  dbName: string;
  dbUrl: string;
  createdAt: string;
}

export interface ControlPlaneGrant {
  userId: string;
  workspaceId: string;
  role: string;
  createdAt: string;
}

export interface BenchmarkPrice {
  seriesId: string;
  dateKey: string;
  value: string;
}

export interface ProviderCooldown {
  provider: string;
  cooldownUntil: string;
}

/** Default delivery cap for a durable job (#887): after this many leases a further
 *  failure is terminal (`dead`). Overridable per-enqueue. */
export const DEFAULT_JOB_MAX_ATTEMPTS = 5;

/**
 * A durable job's lifecycle state (#887, PRD #999 S3). `pending` is eligible to be
 * leased once its `runAfter` passes; `leased` is held by a worker until the lease
 * lapses (then it is reclaimable — crash recovery); `done`/`dead` are terminal
 * (acked success / gave up after a non-retriable error or exhausted attempts).
 */
export type JobStatus = "pending" | "leased" | "done" | "dead";

/**
 * A structured, retriable-classified failure recorded on a job — the SAME
 * `{ code, message, retriable }` shape as S1's `SyncRunError` / S2's `SyncJobError`,
 * kept structural here so the control plane never imports the workspace-side job
 * contract. The queue decides re-enqueue from `retriable` without re-parsing a
 * free-text message.
 */
export interface JobError {
  code: string;
  message: string;
  retriable: boolean;
}

/**
 * One durable job row (#887, PRD #999 S3): the TECHNICAL state of a unit of sync
 * work, in the control plane beside the other coordination tables
 * (`daily_capture_runs`, `connected_source_sync_usage`). Its OBSERVABLE outcome
 * lives in the workspace's `sync_run` (S1) — this row is the queue's bookkeeping,
 * never the user-facing record (1 job ↔ 1 sync_run). `payload` is opaque to the
 * store (stored verbatim as JSON, exactly like a maintainer-alert payload); the
 * queue layer (`job-queue.ts`) owns its shape.
 */
export interface JobRecord {
  id: string;
  kind: string;
  dedupeKey: string;
  /** The workspace this job targets, or null for a fleet-wide job (daily capture). */
  workspaceId: string | null;
  payload: unknown;
  status: JobStatus;
  /** Delivery attempts so far — incremented on each lease, so a crash-loop is bounded. */
  attempts: number;
  /** Delivery cap: once `attempts` reaches it, a further failure is terminal (`dead`). */
  maxAttempts: number;
  /** Earliest time this job may be leased (ISO). Enqueue sets `now`; a retry pushes it out (backoff). */
  runAfter: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: JobError | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueJobInput {
  kind: string;
  dedupeKey: string;
  workspaceId?: string | null;
  payload: unknown;
  /** Delivery cap; defaults to {@link DEFAULT_JOB_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Earliest lease time (ISO); defaults to {@link now}. */
  runAfter?: string;
  /** The reference "now" (ISO) — injectable so tests are deterministic, matching
   *  the other job primitives. Defaults to the wall clock. */
  now?: string;
}

export interface EnqueueJobResult {
  job: JobRecord;
  /**
   * True when a NEW row was inserted; false when an ACTIVE (`pending`/`leased`)
   * job of the same `dedupeKey` already existed and this enqueue collapsed onto it
   * (single-flight). A terminal predecessor never blocks a fresh enqueue.
   */
  enqueued: boolean;
}

export interface LeaseJobInput {
  /** The worker's stable lease-owner id. */
  owner: string;
  /** How long the lease is held before it lapses (ms). */
  leaseMs: number;
  /** The reference "now" (ISO) — injectable so tests are deterministic. */
  now: string;
}

export interface RenewJobLeaseInput {
  jobId: string;
  owner: string;
  leaseMs: number;
  now: string;
}

export interface FailJobInput {
  jobId: string;
  error: JobError;
  now: string;
  /** ms until a retriable failure becomes eligible again (backoff). Ignored when terminal. */
  retryDelayMs?: number;
  /**
   * The caller's lease-owner id. When set, the failure is applied ONLY if the job
   * is still leased to this owner — a worker whose lease already lapsed (another
   * worker reclaimed the job) must not stomp the new owner's state. Omit to force.
   */
  owner?: string;
}

/**
 * The three maintainer-alert categories (#1050, ADR 0064). `infidelity`: the
 * painted/persisted figure diverges from the engine's recomputation (the #1042
 * class of bug). `residual`: an unexplained residual above the documented
 * modeling tolerance after normalizing and verifying config. `sync_source`: the
 * smell is a connected-source/sync ownership problem, not a worthline calc bug.
 */
export type MaintainerAlertCategory = "infidelity" | "residual" | "sync_source";

/** An alert's lifecycle state (#1050): `open` accumulates occurrences; `resolved`/`dismissed` close it. */
export type MaintainerAlertStatus = "open" | "resolved" | "dismissed";

/**
 * One recorded occurrence of a maintainer alert (#1050). Every occurrence carries
 * the FULL forensic payload as opaque JSON — the store never inspects it, so it
 * stays decoupled from the agent-view calculation-trace shape it embeds.
 */
export interface MaintainerAlertOccurrence {
  id: string;
  payload: unknown;
  occurredAt: string;
}

/**
 * A maintainer alert (#1050, decision #1038, ADR 0064): a suspected-bug signal
 * the assistant raised, stored ENTIRELY in the control plane so no workspace
 * export can drag maintainer material out. Dedup key is
 * `workspace_id + holding_id + category`: while one is `open` a re-raise
 * accumulates an occurrence; once closed, a re-raise mints a NEW alert linked
 * back via {@link supersedesAlertId} (it smells like a regression).
 */
export interface MaintainerAlert {
  id: string;
  workspaceId: string;
  holdingId: string;
  category: MaintainerAlertCategory;
  status: MaintainerAlertStatus;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolutionNote: string | null;
  resolutionLink: string | null;
  resolvedAt: string | null;
  /** The prior closed alert of the same key this one supersedes (regression link), or null. */
  supersedesAlertId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An alert with every occurrence's forensic payload — the `/admin` detail read (#1050). */
export interface MaintainerAlertWithOccurrences extends MaintainerAlert {
  occurrences: MaintainerAlertOccurrence[];
}

export interface RaiseMaintainerAlertInput {
  workspaceId: string;
  holdingId: string;
  category: MaintainerAlertCategory;
  /** The forensic payload (config snapshot, calculation trace, declared figure, …); stored verbatim as JSON. */
  payload: unknown;
  /** When the occurrence happened, as ISO; defaults to now. */
  occurredAt?: string;
}

/** The outcome of raising an alert (#1050): the resulting alert and whether a new row was minted. */
export interface RaisedMaintainerAlert {
  alert: MaintainerAlert;
  /** True when a NEW alert was created (first of its key, or a regression after closure). */
  created: boolean;
}

export interface UpdateMaintainerAlertStatusInput {
  status: Exclude<MaintainerAlertStatus, "open">;
  note?: string;
  link?: string;
}

/** A workspace plus its owner's email — the oldest grant; v1 is always exactly
 * one owner per workspace. `ownerEmail` is null only for a dangling workspace
 * with no grant row (should not happen post-provisioning, but the admin
 * surface must not crash on it, #697). */
export interface ControlPlaneWorkspaceWithOwner extends ControlPlaneWorkspace {
  ownerEmail: string | null;
}

/**
 * Tenancy directory (ADR 0030): users → workspaces → grants. The only concern
 * that knows which workspace a signed-in user owns.
 */
export interface TenancyDirectory {
  /** Idempotent by email: the same address always maps to the same user row. */
  findOrCreateUser(email: string): Promise<ControlPlaneUser>;
  /**
   * Read an existing user by email without creating one — null when unknown.
   * The MCP auth path resolves a caller this way so it never provisions; that
   * stays on first web sign-in (ADR 0030 / ADR 0034).
   */
  findUserByEmail(email: string): Promise<ControlPlaneUser | null>;
  /** Register a freshly provisioned workspace database. */
  createWorkspace(input: {
    dbName: string;
    dbUrl: string;
  }): Promise<ControlPlaneWorkspace>;
  /**
   * Remove a workspace row. The provisioner's loser-side cleanup after losing
   * the first-login race (#733) — the loser never got a grant, so only the
   * workspace row exists.
   */
  deleteWorkspace(workspaceId: string): Promise<void>;
  /** Grant a user access to a workspace (default role `owner`). */
  recordGrant(
    userId: string,
    workspaceId: string,
    role?: string,
  ): Promise<ControlPlaneGrant>;
  /** Read a single grant, or null when the user has no access to the workspace. */
  readGrant(userId: string, workspaceId: string): Promise<ControlPlaneGrant | null>;
  /** Every workspace the user has been granted, oldest grant first. */
  listWorkspacesForUser(userId: string): Promise<ControlPlaneWorkspace[]>;
  /**
   * Every workspace across all users, oldest first. The daily-capture cron's
   * global enumeration seam (ADR 0037) — a system actor with no session, so it
   * lists workspaces directly rather than scoped to a granted user.
   */
  listAllWorkspaces(): Promise<ControlPlaneWorkspace[]>;
  /**
   * A single workspace plus its owner's email, or null when the id is unknown.
   * The admin impersonation seam's lookup (#697): the cookie carries only a
   * workspace id, so resolving "who owns it" (for the banner) and "where does
   * it live" (for the store) both go through this one query.
   */
  getWorkspaceWithOwner(
    workspaceId: string,
  ): Promise<ControlPlaneWorkspaceWithOwner | null>;
  /**
   * Every workspace with its owner's email, oldest first — the admin user list
   * (#697).
   */
  listWorkspacesWithOwners(): Promise<ControlPlaneWorkspaceWithOwner[]>;
}

/** Daily fleet-capture idempotency ledger (ADR 0037, #895). */
export interface DailyCaptureLog {
  /**
   * Whether this fleet-capture pass has already finalized. The key is an opaque
   * run key, not a bare calendar date: since #895 it is pass-qualified
   * (`YYYY-MM-DD:am|pm`) so the morning and evening passes finalize
   * independently — do not query this table by a plain date and expect a match.
   */
  hasDailyCaptureRun(runKey: string): Promise<boolean>;
  /** Record or update this fleet-capture pass's finalization (see `hasDailyCaptureRun`). */
  recordDailyCaptureRun(runKey: string, finalizedAt: string): Promise<void>;
}

/** Benchmark series cached globally in the control plane (ADR 0060). */
export interface BenchmarkPriceCache {
  readBenchmarkPrices(seriesId: string): Promise<BenchmarkPrice[]>;
  /** Upsert monthly benchmark rows by `(series_id, date)`. */
  upsertBenchmarkPrices(
    seriesId: string,
    prices: { dateKey: string; value: string }[],
  ): Promise<void>;
}

/**
 * The day's accumulated AI token totals read by the metering gate (PRD #1160
 * S3, #1163): the workspace's own usage (the per-plan daily budget) and the
 * shared global usage (the daily fuse). Zero when a scope has no row yet.
 */
export interface AiTokenUsage {
  workspaceTokens: number;
  globalTokens: number;
}

/** One day's GLOBAL AI token total — the aggregate spend series for /admin (#1163). */
export interface AiDailyTokenUsage {
  dayKey: string;
  tokens: number;
}

/** One workspace's AI token total for a single UTC day — the /admin entitlements view (#1164). */
export interface WorkspaceDailyTokenUsage {
  workspaceId: string;
  tokens: number;
}

/**
 * Serverless-shared usage limits: the chat and connected-source-sync rate
 * counters (ADR 0051), provider cooldowns, and the AI token meter + daily fuse
 * (#1163). All are operational limits shared by every serverless instance of one
 * deployment; the counters live in the control-plane DB because process memory
 * cannot survive across serverless invocations (ADR 0051).
 */
export interface UsageLimits {
  /**
   * Count one shared-baseline chat request and return the running count for
   * (rateKey, windowKey) — the serverless-safe counter behind the assistant's
   * rate limit (ADR 0051). Increment-then-check: the caller compares the
   * returned count against its limit, so the counter needs no policy.
   */
  recordChatRequest(rateKey: string, windowKey: string): Promise<number>;
  /** Cooldowns shared by every serverless instance of one deployment. */
  readProviderCooldowns(deploymentKey: string): Promise<ProviderCooldown[]>;
  /** Monotonic upsert: concurrent failures may extend but never shorten it. */
  recordProviderCooldown(
    deploymentKey: string,
    provider: string,
    cooldownUntil: string,
  ): Promise<void>;
  /**
   * Count one user-triggered connected-source sync for (rateKey, windowKey).
   * Same increment-then-check contract as chat usage, but kept in a separate
   * table so chat and sync quotas cannot interfere.
   */
  recordConnectedSourceSync(rateKey: string, windowKey: string): Promise<number>;
  /**
   * Count one free-plan courtesy assistant turn for (rateKey, monthKey) and
   * return the running count (PRD #1160 S2, #1162): the free assistant's monthly
   * product quota over the ADR 0051 mechanism. Same increment-then-check
   * contract as chat usage, but a MONTHLY window and its own table — a distinct
   * concern from the hourly operational throttle, so the two never interfere and
   * a future sweep of stale hourly rows can never purge a month's courtesy count.
   */
  recordAssistantCourtesyUse(rateKey: string, monthKey: string): Promise<number>;
  /**
   * Add `tokens` of assistant AI usage to BOTH this workspace's and the shared
   * global daily counters (PRD #1160 S3, #1163) for `dayKey` (UTC "YYYY-MM-DD").
   * The per-plan workspace budget and the global daily fuse both read from these
   * counters. Aggregate only — never any content (#1131). Recorded AFTER a turn
   * completes (the token count is only known then), so a single turn may overshoot
   * before the next is refused; that increment-then-check tolerance is by design.
   */
  recordAiTokenUsage(workspaceId: string, dayKey: string, tokens: number): Promise<void>;
  /**
   * The day's accumulated token totals for the pre-call gate (#1163): the
   * workspace's own usage (against its plan budget) and the global shared usage
   * (against the daily fuse). Zero for a scope with no row yet.
   */
  readAiTokenUsage(workspaceId: string, dayKey: string): Promise<AiTokenUsage>;
  /**
   * Global daily token totals from `sinceDayKey` onward (inclusive), newest
   * first — the aggregate spend series /admin renders (#1163). Global scope
   * only: no per-workspace rows, never any content.
   */
  readRecentGlobalAiTokenUsage(sinceDayKey: string): Promise<AiDailyTokenUsage[]>;
  /**
   * Per-workspace token totals for one UTC day — the /admin entitlements view
   * (#1164). Workspace scope only (`ws:*`), never the global fuse; aggregate
   * only, never any content (#1131). A workspace with no usage that day is
   * simply absent.
   */
  listWorkspaceAiTokenUsage(dayKey: string): Promise<WorkspaceDailyTokenUsage[]>;
}

/** Global exposure-profile catalog (PRD #711 S1 / #940). */
/**
 * Read + system-registration access to the global exposure-profile catalog
 * (PRD #711 S1 / #940, ADR 0058). This is the broadly-visible port every
 * control-plane consumer may hold: reading the catalog, and registering the
 * empty stub a holding is born with. Content CURATION (create / update / rekey /
 * delete) deliberately does NOT live here — it is on {@link
 * ExposureProfileCatalogAdmin}, off this port, so no ordinary caller can rewrite
 * curated data (#1123, retaining the capability in the interface).
 */
export interface ExposureProfileCatalog {
  /**
   * Register an empty, curatable catalog row for a market holding's identity if
   * one does not already exist (#1097, ADR 0058 amendment). Idempotent by
   * `identity_key` and NON-destructive: an existing row — curated data or a prior
   * stub — is left untouched (no display-name rewrite). This is a system action
   * (the row is born with the holding), distinct from admin data curation
   * (`createGlobalExposureProfile`/`updateGlobalExposureProfile`), so it never
   * validates content and is allowed to be completely empty.
   */
  ensureGlobalExposureProfileStub(
    identity: GlobalExposureProfileIdentity,
    displayName?: string | null,
  ): Promise<void>;
  readGlobalExposureProfile(
    identity: RawGlobalExposureProfileIdentityInput,
  ): Promise<GlobalExposureProfile | null>;
  readGlobalExposureProfiles(): Promise<GlobalExposureProfile[]>;
}

/**
 * Admin curation of the global exposure-profile catalog (PRD #711 S4, decision
 * #941). These content writes are the capability #1123 retains in the interface:
 * they are reachable ONLY through the admin control-plane surface ({@link
 * createAdminControlPlaneStore} / the `/admin/catalogo` server actions), never
 * from the base {@link ControlPlaneStore} a request-scoped consumer holds. A
 * non-admin surface rewriting curated catalog content is now unrepresentable by
 * type, not merely grep-detectable.
 */
export interface ExposureProfileCatalogAdmin extends ExposureProfileCatalog {
  createGlobalExposureProfile(
    input: CreateGlobalExposureProfileInput,
  ): Promise<GlobalExposureProfile>;
  updateGlobalExposureProfile(
    identity: RawGlobalExposureProfileIdentityInput,
    input: UpdateGlobalExposureProfileInput,
  ): Promise<GlobalExposureProfile>;
  rekeyGlobalExposureProfile(
    from: RawGlobalExposureProfileIdentityInput,
    to: RawGlobalExposureProfileIdentityInput,
  ): Promise<GlobalExposureProfile>;
  deleteGlobalExposureProfile(
    identity: RawGlobalExposureProfileIdentityInput,
  ): Promise<void>;
}

/** Maintainer alert log (#1050, ADR 0064) — the `/admin` alerts surface. */
export interface MaintainerAlertLog {
  /**
   * Raise a maintainer alert (#1050, ADR 0064). Dedup by
   * `workspaceId + holdingId + category`: an existing OPEN alert of that key
   * accumulates a new occurrence; otherwise a fresh alert is minted, linked to
   * the most recent closed alert of the same key (regression) when one exists.
   */
  raiseMaintainerAlert(input: RaiseMaintainerAlertInput): Promise<RaisedMaintainerAlert>;
  /** Every alert across all workspaces, most-recently-seen first (the `/admin` list). */
  listMaintainerAlerts(): Promise<MaintainerAlert[]>;
  /** One alert with every occurrence's forensic payload, or null when unknown. */
  getMaintainerAlert(alertId: string): Promise<MaintainerAlertWithOccurrences | null>;
  /** Close an alert (`resolved`/`dismissed`) with an optional note/link. Throws when unknown. */
  updateMaintainerAlertStatus(
    alertId: string,
    input: UpdateMaintainerAlertStatusInput,
  ): Promise<MaintainerAlert>;
  /** Count of currently-open alerts — the `/admin` badge. */
  countOpenMaintainerAlerts(): Promise<number>;
}

export interface StartTrialInput {
  /** The identity consuming its one trial (#1128) — trials are per user, not per workspace. */
  userId: string;
  /** The freshly provisioned workspace the trial entitles. */
  workspaceId: string;
  /** The reference "now" (ISO) — injectable so tests are deterministic. Defaults to the wall clock. */
  now?: string;
}

/** Input for the admin premium palanca (PRD #1160 S4, #1164). */
export interface GrantPremiumInput {
  workspaceId: string;
  /**
   * Until when the grant holds (ISO), or null for an INDEFINITE grant — the
   * beta/comps/lifetime carril (#1133). `deriveEffectivePlan` honors the date
   * regardless of the declared plan, so a dated grant lapses on its own with no
   * expiry job; an indefinite one holds until an explicit revoke.
   */
  premiumUntil: string | null;
}

/**
 * Workspace entitlements (PRD #1160 S1, #1161): the stored `free|trial|premium`
 * row beside the grant, plus the set-once activation timestamps (#1131). The
 * control plane is the ONLY source of truth here — billing webhooks and the
 * admin palanca write it, every surface derives from it (`deriveEffectivePlan`),
 * and nothing queries the merchant-of-record on a hot path.
 */
export interface EntitlementDirectory {
  /**
   * The stored entitlement row, or null when none exists — which reads as
   * `free` with no trial consumed (the pre-#1161 migration story: existing
   * workspaces get no row and need no backfill).
   */
  readWorkspaceEntitlement(workspaceId: string): Promise<WorkspaceEntitlement | null>;
  /**
   * Start the identity's one trial for a freshly provisioned workspace (#1128):
   * atomically consume the per-user trial marker (set-once — an INSERT that
   * loses means the trial was already used, so re-provisioning NEVER re-trials)
   * and write the workspace's `trial` entitlement with its window. Returns the
   * entitlement, or null when this identity already used its trial.
   */
  startTrialIfUnused(input: StartTrialInput): Promise<WorkspaceEntitlement | null>;
  /**
   * Record that the workspace completed onboarding (#1131). Set-once: the first
   * call wins, every later call is a no-op — the timestamp says only THAT it
   * happened, never what the workspace holds.
   */
  markWorkspaceOnboarded(workspaceId: string, at: string): Promise<void>;
  /** Record that the workspace holds its first holding (#1131). Set-once, like `markWorkspaceOnboarded`. */
  markWorkspaceFirstHolding(workspaceId: string, at: string): Promise<void>;
  /** Every stored entitlement row — the /admin entitlements view (#1164). Order unspecified; callers join by workspace id. */
  listWorkspaceEntitlements(): Promise<WorkspaceEntitlement[]>;
  /**
   * The admin premium palanca (PRD #1160 S4, #1164): declare a workspace
   * `premium` with `premiumUntil` (a dated grant) or null (indefinite). Upsert —
   * creates the row for a workspace that never had one, or overwrites the plan
   * and window on an existing row, always preserving the set-once activation
   * timestamps and the trial marker. Returns the resulting row.
   */
  grantWorkspacePremium(input: GrantPremiumInput): Promise<WorkspaceEntitlement>;
  /**
   * Revoke a premium grant (#1164): drop the workspace back to `free` and clear
   * `premiumUntil`. A workspace with no row is already free, so this is a no-op
   * there. The trial marker and activation timestamps are left untouched — this
   * removes only the premium grant, never rewrites history.
   */
  revokeWorkspacePremium(workspaceId: string): Promise<void>;
}

/** Durable job queue (#887, PRD #999 S3). */
export interface JobStore {
  /**
   * Durably enqueue a job (#887, PRD #999 S3). Single-flight by `dedupeKey`: if an
   * ACTIVE (`pending`/`leased`) job of the same key already exists, no row is
   * inserted and that job is returned with `enqueued: false`. A terminal
   * (`done`/`dead`) predecessor never blocks a fresh enqueue.
   */
  enqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult>;
  /**
   * Atomically lease the next ready job for a worker (#887): the oldest job that is
   * `pending`, OR whose `leased` lease has expired (crash recovery), with
   * `runAfter <= now`. Marks it `leased`, stamps the owner + `now + leaseMs` expiry,
   * and increments `attempts` (so a redelivery from a lapsed lease is bounded by
   * `maxAttempts`). Returns null when nothing is ready. Safe under concurrent
   * workers: a guarded UPDATE means only one worker wins a given row.
   */
  leaseJob(input: LeaseJobInput): Promise<JobRecord | null>;
  /** Extend a held lease iff still owned by `owner`; returns false when the lease was lost. */
  renewJobLease(input: RenewJobLeaseInput): Promise<boolean>;
  /**
   * Mark a job `done` (terminal success) and release its lease. Pass `owner` to ack
   * ONLY while still holding the lease — a worker whose lease lapsed (the job was
   * reclaimed) must not ack the new owner's run. Omit to force (unconditional).
   */
  completeJob(jobId: string, owner?: string): Promise<void>;
  /**
   * Record a job failure (#887): if the error is `retriable` and attempts remain
   * (`attempts < maxAttempts`), the job returns to `pending` with
   * `runAfter = now + retryDelayMs` (backoff); otherwise it is `dead`. The typed
   * error is stored as `lastError` either way. Returns the updated job. Throws when
   * the job id is unknown.
   */
  failJob(input: FailJobInput): Promise<JobRecord>;
  /** Read one job by id, or null when unknown. */
  readJob(jobId: string): Promise<JobRecord | null>;
  /** Every job, newest first — observability / tests. */
  listJobs(): Promise<JobRecord[]>;
}

/**
 * The full control plane: one libSQL database (ADR 0030) exposing every
 * cohesive port over a single shared connection. Consumers should depend on the
 * narrowest port they use (e.g. {@link TenancyDirectory}, {@link JobStore}) so
 * no caller sees a concern it does not touch; this composite is the assembled
 * adapter returned by the factories and the type held by the composition root.
 */
export interface ControlPlaneStore
  extends TenancyDirectory,
    EntitlementDirectory,
    DailyCaptureLog,
    BenchmarkPriceCache,
    UsageLimits,
    ExposureProfileCatalog,
    MaintainerAlertLog,
    JobStore {
  close(): void;
}

/**
 * The admin control plane: the full {@link ControlPlaneStore} plus exposure-
 * profile catalog curation ({@link ExposureProfileCatalogAdmin}). Held ONLY by
 * the `/admin` surface, opened through {@link createAdminControlPlaneStore};
 * ordinary request-scoped consumers get the narrower {@link ControlPlaneStore},
 * whose {@link ExposureProfileCatalog} port cannot reach the catalog content
 * writes (#1123).
 */
export interface AdminControlPlaneStore
  extends ControlPlaneStore,
    ExposureProfileCatalogAdmin {}

export interface ControlPlaneStoreOptions {
  url?: string;
  authToken?: string;
  /** Id generator, injectable so tests stay deterministic. */
  newId?: () => string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  db_name TEXT NOT NULL UNIQUE,
  db_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS grants (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, workspace_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
-- Self-healing for pre-#733 duplicates: demote every owner grant that has an
-- older sibling for the same user (rowid breaks created_at ties), so the
-- unique index below can always be created on an existing database. Matches
-- prior behavior — later logins already picked the oldest grant.
UPDATE grants SET role = 'orphaned-owner'
WHERE role = 'owner' AND EXISTS (
  SELECT 1 FROM grants older
  WHERE older.user_id = grants.user_id AND older.role = 'owner'
    AND (older.created_at < grants.created_at
      OR (older.created_at = grants.created_at AND older.rowid < grants.rowid))
);
-- One owned workspace per user (#733): the database-level arbiter for the
-- provisioner's check-then-create race. Partial so a future sharing flow can
-- still grant the same user other workspaces under non-owner roles.
CREATE UNIQUE INDEX IF NOT EXISTS grants_one_owner_per_user
  ON grants(user_id) WHERE role = 'owner';
CREATE TABLE IF NOT EXISTS workspace_entitlements (
  workspace_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  trial_ends_at TEXT,
  premium_until TEXT,
  billing_provider TEXT,
  billing_customer_id TEXT,
  subscription_id TEXT,
  subscription_status TEXT,
  onboarded_at TEXT,
  first_holding_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
-- One trial per identity (#1128): the row's existence IS the marker, so the
-- set-once arbiter is the primary key — an insert that loses means "already used".
CREATE TABLE IF NOT EXISTS user_trials (
  user_id TEXT NOT NULL PRIMARY KEY,
  used_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS daily_capture_runs (
  date_key TEXT PRIMARY KEY,
  finalized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chat_usage (
  rate_key TEXT NOT NULL,
  window_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (rate_key, window_key)
);
CREATE TABLE IF NOT EXISTS provider_cooldowns (
  deployment_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  cooldown_until TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (deployment_key, provider)
);
CREATE TABLE IF NOT EXISTS connected_source_sync_usage (
  rate_key TEXT NOT NULL,
  window_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (rate_key, window_key)
);
CREATE TABLE IF NOT EXISTS assistant_courtesy_usage (
  rate_key TEXT NOT NULL,
  window_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (rate_key, window_key)
);
-- AI token meter (#1163): aggregate tokens per scope per UTC day. scope_key is
-- 'global' (the shared daily fuse) or 'ws:<workspaceId>' (the per-plan budget).
-- Rows are tiny (one per scope per day) and self-expire by day key; no sweep.
CREATE TABLE IF NOT EXISTS ai_token_usage (
  scope_key TEXT NOT NULL,
  day_key TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope_key, day_key)
);
CREATE TABLE IF NOT EXISTS benchmark_prices (
  series_id TEXT NOT NULL,
  date TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (series_id, date)
);
CREATE TABLE IF NOT EXISTS global_exposure_profiles (
  identity_key TEXT PRIMARY KEY NOT NULL,
  identity_kind TEXT NOT NULL,
  isin TEXT,
  price_provider TEXT,
  provider_symbol TEXT,
  display_name TEXT,
  breakdowns_json TEXT NOT NULL DEFAULT '{}',
  ter TEXT,
  tracked_index TEXT,
  hedged_to_currency TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS global_exposure_profiles_isin
  ON global_exposure_profiles(isin) WHERE isin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS global_exposure_profiles_provider
  ON global_exposure_profiles(price_provider, provider_symbol)
  WHERE price_provider IS NOT NULL AND provider_symbol IS NOT NULL;
CREATE TABLE IF NOT EXISTS maintainer_alerts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  holding_id TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolution_note TEXT,
  resolution_link TEXT,
  resolved_at TEXT,
  supersedes_alert_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- At most one OPEN alert per (workspace, holding, category): the arbiter for the
-- dedup contract. Partial so a closed alert never blocks a fresh (regression) one.
CREATE UNIQUE INDEX IF NOT EXISTS maintainer_alerts_one_open_per_key
  ON maintainer_alerts(workspace_id, holding_id, category) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS maintainer_alerts_recency
  ON maintainer_alerts(last_seen_at);
CREATE TABLE IF NOT EXISTS maintainer_alert_occurrences (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (alert_id) REFERENCES maintainer_alerts(id)
);
CREATE INDEX IF NOT EXISTS maintainer_alert_occurrences_alert
  ON maintainer_alert_occurrences(alert_id);
CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  workspace_id TEXT,
  payload_json TEXT NOT NULL DEFAULT 'null',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- At most one ACTIVE job per dedupe_key: the arbiter for single-flight. Partial so
-- a terminal (done/dead) job never blocks a fresh enqueue of the same key.
CREATE UNIQUE INDEX IF NOT EXISTS job_active_dedupe
  ON job(dedupe_key) WHERE status IN ('pending', 'leased');
-- The lease/claim scan: ready jobs ordered by eligibility.
CREATE INDEX IF NOT EXISTS job_ready ON job(status, run_after);
`;

function toUser(row: Record<string, unknown>): ControlPlaneUser {
  return {
    id: String(row["id"]),
    email: String(row["email"]),
    createdAt: String(row["created_at"]),
  };
}

function toWorkspace(row: Record<string, unknown>): ControlPlaneWorkspace {
  return {
    id: String(row["id"]),
    dbName: String(row["db_name"]),
    dbUrl: String(row["db_url"]),
    createdAt: String(row["created_at"]),
  };
}

function toGrant(row: Record<string, unknown>): ControlPlaneGrant {
  return {
    userId: String(row["user_id"]),
    workspaceId: String(row["workspace_id"]),
    role: String(row["role"]),
    createdAt: String(row["created_at"]),
  };
}

function toWorkspaceWithOwner(
  row: Record<string, unknown>,
): ControlPlaneWorkspaceWithOwner {
  return {
    ...toWorkspace(row),
    ownerEmail: row["owner_email"] == null ? null : String(row["owner_email"]),
  };
}

function toWorkspaceEntitlement(row: Record<string, unknown>): WorkspaceEntitlement {
  const text = (column: string): string | null =>
    row[column] == null ? null : String(row[column]);
  return {
    workspaceId: String(row["workspace_id"]),
    plan: String(row["plan"]) as WorkspaceEntitlement["plan"],
    trialEndsAt: text("trial_ends_at"),
    premiumUntil: text("premium_until"),
    billingProvider: text("billing_provider"),
    billingCustomerId: text("billing_customer_id"),
    subscriptionId: text("subscription_id"),
    subscriptionStatus: text("subscription_status"),
    onboardedAt: text("onboarded_at"),
    firstHoldingAt: text("first_holding_at"),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function toBenchmarkPrice(row: Record<string, unknown>): BenchmarkPrice {
  return {
    seriesId: String(row["series_id"]),
    dateKey: String(row["date"]),
    value: String(row["value"]),
  };
}

function toMaintainerAlert(row: Record<string, unknown>): MaintainerAlert {
  return {
    id: String(row["id"]),
    workspaceId: String(row["workspace_id"]),
    holdingId: String(row["holding_id"]),
    category: String(row["category"]) as MaintainerAlertCategory,
    status: String(row["status"]) as MaintainerAlertStatus,
    occurrenceCount: Number(row["occurrence_count"]),
    firstSeenAt: String(row["first_seen_at"]),
    lastSeenAt: String(row["last_seen_at"]),
    resolutionNote:
      row["resolution_note"] == null ? null : String(row["resolution_note"]),
    resolutionLink:
      row["resolution_link"] == null ? null : String(row["resolution_link"]),
    resolvedAt: row["resolved_at"] == null ? null : String(row["resolved_at"]),
    supersedesAlertId:
      row["supersedes_alert_id"] == null ? null : String(row["supersedes_alert_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function toMaintainerAlertOccurrence(
  row: Record<string, unknown>,
): MaintainerAlertOccurrence {
  return {
    id: String(row["id"]),
    payload: JSON.parse(String(row["payload_json"])),
    occurredAt: String(row["occurred_at"]),
  };
}

/** True when an INSERT lost the race for the one-open-alert-per-key index (#1050). */
function isOpenKeyConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*maintainer_alerts/i.test(message);
}

/** True when a job INSERT tripped the active-dedupe index (single-flight, #887). */
function isJobDedupeConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*job\.dedupe_key|job_active_dedupe/i.test(message);
}

function toJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row["id"]),
    kind: String(row["kind"]),
    dedupeKey: String(row["dedupe_key"]),
    workspaceId: row["workspace_id"] == null ? null : String(row["workspace_id"]),
    payload: JSON.parse(String(row["payload_json"] ?? "null")),
    status: String(row["status"]) as JobStatus,
    attempts: Number(row["attempts"]),
    maxAttempts: Number(row["max_attempts"]),
    runAfter: String(row["run_after"]),
    leaseOwner: row["lease_owner"] == null ? null : String(row["lease_owner"]),
    leaseExpiresAt:
      row["lease_expires_at"] == null ? null : String(row["lease_expires_at"]),
    lastError:
      row["last_error_json"] == null
        ? null
        : (JSON.parse(String(row["last_error_json"])) as JobError),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

/** ISO string `ms` milliseconds after the reference `now`. */
function isoPlusMs(now: string, ms: number): string {
  return new Date(new Date(now).getTime() + ms).toISOString();
}

function toGlobalExposureProfileIdentity(
  row: Record<string, unknown>,
): GlobalExposureProfileIdentity {
  const kind = String(row["identity_kind"]);
  if (kind === "isin") {
    return { isin: String(row["isin"]), kind: "isin" };
  }
  return {
    kind: "provider",
    priceProvider: String(row["price_provider"]) as InvestmentPriceProvider,
    providerSymbol: String(row["provider_symbol"]),
  };
}

function toGlobalExposureProfile(row: Record<string, unknown>): GlobalExposureProfile {
  return {
    identity: toGlobalExposureProfileIdentity(row),
    displayName: row["display_name"] == null ? null : String(row["display_name"]),
    breakdowns: JSON.parse(
      String(row["breakdowns_json"]),
    ) as GlobalExposureProfileBreakdowns,
    ter: row["ter"] == null ? null : String(row["ter"]),
    trackedIndex: row["tracked_index"] == null ? null : String(row["tracked_index"]),
    hedgedToCurrency:
      row["hedged_to_currency"] == null ? null : String(row["hedged_to_currency"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function identityColumns(identity: GlobalExposureProfileIdentity): {
  identityKey: string;
  identityKind: string;
  isin: string | null;
  priceProvider: string | null;
  providerSymbol: string | null;
} {
  if (identity.kind === "isin") {
    return {
      identityKey: globalExposureProfileIdentityKey(identity),
      identityKind: "isin",
      isin: identity.isin,
      priceProvider: null,
      providerSymbol: null,
    };
  }
  return {
    identityKey: globalExposureProfileIdentityKey(identity),
    identityKind: "provider",
    isin: null,
    priceProvider: identity.priceProvider,
    providerSymbol: identity.providerSymbol,
  };
}

/** Correlated subquery: the oldest grant's owner email for a given workspace —
 * shared by the single-workspace and list-all queries below. */
const OWNER_EMAIL_SUBQUERY = `(
  SELECT u.email FROM grants g
  JOIN users u ON u.id = g.user_id
  WHERE g.workspace_id = w.id
  ORDER BY g.created_at ASC
  LIMIT 1
) AS owner_email`;

async function buildControlPlaneStore(
  client: Client,
  newId: () => string,
): Promise<AdminControlPlaneStore> {
  await client.executeMultiple(SCHEMA);
  await migrateControlPlane(client);

  /**
   * One pass of {@link ControlPlaneStore.raiseMaintainerAlert}: accumulate onto
   * the open alert of this key, or mint a fresh one (linked to the prior closed
   * alert as a regression). Occurrence count is recomputed from the actual rows
   * rather than incremented, so a crash between the two writes self-heals on the
   * next raise instead of drifting.
   */
  async function raiseMaintainerAlertOnce({
    workspaceId,
    holdingId,
    category,
    payload,
    occurredAt,
  }: RaiseMaintainerAlertInput): Promise<RaisedMaintainerAlert> {
    const stamp = occurredAt ?? new Date().toISOString();
    const payloadJson = JSON.stringify(payload ?? null);

    const open = await client.execute({
      sql: `SELECT * FROM maintainer_alerts
            WHERE workspace_id = ? AND holding_id = ? AND category = ? AND status = 'open'
            LIMIT 1`,
      args: [workspaceId, holdingId, category],
    });

    if (open.rows.length > 0) {
      const alertId = String(open.rows[0]!["id"]);
      await client.execute({
        sql: `INSERT INTO maintainer_alert_occurrences (id, alert_id, payload_json, occurred_at)
              VALUES (?, ?, ?, ?)`,
        args: [newId(), alertId, payloadJson, stamp],
      });
      await client.execute({
        sql: `UPDATE maintainer_alerts SET
                occurrence_count = (
                  SELECT COUNT(*) FROM maintainer_alert_occurrences WHERE alert_id = ?
                ),
                last_seen_at = MAX(last_seen_at, ?),
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
        args: [alertId, stamp, alertId],
      });
      const reread = await client.execute({
        sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      return { alert: toMaintainerAlert(reread.rows[0]!), created: false };
    }

    // No open alert of this key: mint a fresh one, linked to the most recent
    // closed alert of the same key (a re-trigger after closure smells like a
    // regression — #1050).
    const priorClosed = await client.execute({
      sql: `SELECT id FROM maintainer_alerts
            WHERE workspace_id = ? AND holding_id = ? AND category = ? AND status != 'open'
            ORDER BY last_seen_at DESC, rowid DESC
            LIMIT 1`,
      args: [workspaceId, holdingId, category],
    });
    const supersedesAlertId =
      priorClosed.rows.length > 0 ? String(priorClosed.rows[0]!["id"]) : null;

    const alertId = newId();
    await client.execute({
      sql: `INSERT INTO maintainer_alerts (
              id, workspace_id, holding_id, category, status, occurrence_count,
              first_seen_at, last_seen_at, supersedes_alert_id
            ) VALUES (?, ?, ?, ?, 'open', 1, ?, ?, ?)`,
      args: [alertId, workspaceId, holdingId, category, stamp, stamp, supersedesAlertId],
    });
    await client.execute({
      sql: `INSERT INTO maintainer_alert_occurrences (id, alert_id, payload_json, occurred_at)
            VALUES (?, ?, ?, ?)`,
      args: [newId(), alertId, payloadJson, stamp],
    });
    const created = await client.execute({
      sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
      args: [alertId],
    });
    return { alert: toMaintainerAlert(created.rows[0]!), created: true };
  }

  return {
    async findOrCreateUser(email) {
      const existing = await client.execute({
        sql: "SELECT id, email, created_at FROM users WHERE email = ?",
        args: [email],
      });
      if (existing.rows.length > 0) {
        return toUser(existing.rows[0]!);
      }
      // ON CONFLICT: two concurrent first logins may both pass the select
      // above (#733); whichever insert lands second becomes a no-op and both
      // resolve to the same row via the re-select by email.
      await client.execute({
        sql: "INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING",
        args: [newId(), email],
      });
      const created = await client.execute({
        sql: "SELECT id, email, created_at FROM users WHERE email = ?",
        args: [email],
      });
      return toUser(created.rows[0]!);
    },
    async findUserByEmail(email) {
      const result = await client.execute({
        sql: "SELECT id, email, created_at FROM users WHERE email = ?",
        args: [email],
      });
      return result.rows.length > 0 ? toUser(result.rows[0]!) : null;
    },
    async createWorkspace({ dbName, dbUrl }) {
      const id = newId();
      await client.execute({
        sql: "INSERT INTO workspaces (id, db_name, db_url) VALUES (?, ?, ?)",
        args: [id, dbName, dbUrl],
      });
      const created = await client.execute({
        sql: "SELECT id, db_name, db_url, created_at FROM workspaces WHERE id = ?",
        args: [id],
      });
      return toWorkspace(created.rows[0]!);
    },
    async deleteWorkspace(workspaceId) {
      await client.execute({
        sql: "DELETE FROM workspaces WHERE id = ?",
        args: [workspaceId],
      });
    },
    async recordGrant(userId, workspaceId, role = "owner") {
      await client.execute({
        sql: "INSERT INTO grants (user_id, workspace_id, role) VALUES (?, ?, ?)",
        args: [userId, workspaceId, role],
      });
      const created = await client.execute({
        sql: "SELECT user_id, workspace_id, role, created_at FROM grants WHERE user_id = ? AND workspace_id = ?",
        args: [userId, workspaceId],
      });
      return toGrant(created.rows[0]!);
    },
    async readGrant(userId, workspaceId) {
      const result = await client.execute({
        sql: "SELECT user_id, workspace_id, role, created_at FROM grants WHERE user_id = ? AND workspace_id = ?",
        args: [userId, workspaceId],
      });
      return result.rows.length > 0 ? toGrant(result.rows[0]!) : null;
    },
    async listWorkspacesForUser(userId) {
      const result = await client.execute({
        sql: `SELECT w.id, w.db_name, w.db_url, w.created_at
              FROM workspaces w
              JOIN grants g ON g.workspace_id = w.id
              WHERE g.user_id = ?
              ORDER BY g.created_at ASC`,
        args: [userId],
      });
      return result.rows.map((row) => toWorkspace(row));
    },
    async listAllWorkspaces() {
      const result = await client.execute(
        "SELECT id, db_name, db_url, created_at FROM workspaces ORDER BY created_at ASC",
      );
      return result.rows.map((row) => toWorkspace(row));
    },
    async getWorkspaceWithOwner(workspaceId) {
      const result = await client.execute({
        sql: `SELECT w.id, w.db_name, w.db_url, w.created_at, ${OWNER_EMAIL_SUBQUERY}
              FROM workspaces w
              WHERE w.id = ?`,
        args: [workspaceId],
      });
      return result.rows.length > 0 ? toWorkspaceWithOwner(result.rows[0]!) : null;
    },
    async listWorkspacesWithOwners() {
      const result = await client.execute(
        `SELECT w.id, w.db_name, w.db_url, w.created_at, ${OWNER_EMAIL_SUBQUERY}
         FROM workspaces w
         ORDER BY w.created_at ASC`,
      );
      return result.rows.map((row) => toWorkspaceWithOwner(row));
    },
    async readWorkspaceEntitlement(workspaceId) {
      const result = await client.execute({
        sql: "SELECT * FROM workspace_entitlements WHERE workspace_id = ?",
        args: [workspaceId],
      });
      return result.rows.length > 0 ? toWorkspaceEntitlement(result.rows[0]!) : null;
    },
    async startTrialIfUnused({ userId, workspaceId, now }) {
      const stamp = now ?? new Date().toISOString();
      // The per-identity marker is the arbiter (#1128): losing this insert means
      // the trial was already consumed — by an earlier workspace, or by the
      // concurrent provision that won — so there is nothing left to start.
      const consumed = await client.execute({
        sql: `INSERT INTO user_trials (user_id, used_at) VALUES (?, ?)
              ON CONFLICT(user_id) DO NOTHING`,
        args: [userId, stamp],
      });
      if (consumed.rowsAffected === 0) {
        return null;
      }
      await client.execute({
        sql: `INSERT INTO workspace_entitlements (workspace_id, plan, trial_ends_at)
              VALUES (?, 'trial', ?)
              ON CONFLICT(workspace_id) DO UPDATE SET
                plan = 'trial',
                trial_ends_at = excluded.trial_ends_at,
                updated_at = CURRENT_TIMESTAMP`,
        args: [workspaceId, trialEndsAtFrom(stamp)],
      });
      const created = await client.execute({
        sql: "SELECT * FROM workspace_entitlements WHERE workspace_id = ?",
        args: [workspaceId],
      });
      return toWorkspaceEntitlement(created.rows[0]!);
    },
    async markWorkspaceOnboarded(workspaceId, at) {
      // Set-once via COALESCE: the first stamp wins, later calls are no-ops.
      await client.execute({
        sql: `INSERT INTO workspace_entitlements (workspace_id, onboarded_at)
              VALUES (?, ?)
              ON CONFLICT(workspace_id) DO UPDATE SET
                onboarded_at = COALESCE(onboarded_at, excluded.onboarded_at),
                updated_at = CURRENT_TIMESTAMP`,
        args: [workspaceId, at],
      });
    },
    async markWorkspaceFirstHolding(workspaceId, at) {
      await client.execute({
        sql: `INSERT INTO workspace_entitlements (workspace_id, first_holding_at)
              VALUES (?, ?)
              ON CONFLICT(workspace_id) DO UPDATE SET
                first_holding_at = COALESCE(first_holding_at, excluded.first_holding_at),
                updated_at = CURRENT_TIMESTAMP`,
        args: [workspaceId, at],
      });
    },
    async listWorkspaceEntitlements() {
      const result = await client.execute("SELECT * FROM workspace_entitlements");
      return result.rows.map((row) => toWorkspaceEntitlement(row));
    },
    async grantWorkspacePremium({ workspaceId, premiumUntil }) {
      // Upsert onto plan='premium' with the (possibly null → indefinite) window,
      // leaving the trial marker and set-once timestamps intact — a grant only
      // asserts the premium state, it never rewrites activation history.
      await client.execute({
        sql: `INSERT INTO workspace_entitlements (workspace_id, plan, premium_until)
              VALUES (?, 'premium', ?)
              ON CONFLICT(workspace_id) DO UPDATE SET
                plan = 'premium',
                premium_until = excluded.premium_until,
                updated_at = CURRENT_TIMESTAMP`,
        args: [workspaceId, premiumUntil],
      });
      const created = await client.execute({
        sql: "SELECT * FROM workspace_entitlements WHERE workspace_id = ?",
        args: [workspaceId],
      });
      return toWorkspaceEntitlement(created.rows[0]!);
    },
    async revokeWorkspacePremium(workspaceId) {
      // No INSERT: a workspace with no row is already free. Touch only the
      // premium fields, so a live trial (its own column) and the activation
      // timestamps survive the revoke.
      await client.execute({
        sql: `UPDATE workspace_entitlements
              SET plan = 'free', premium_until = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE workspace_id = ?`,
        args: [workspaceId],
      });
    },
    async hasDailyCaptureRun(dateKey) {
      const result = await client.execute({
        sql: "SELECT 1 FROM daily_capture_runs WHERE date_key = ? LIMIT 1",
        args: [dateKey],
      });
      return result.rows.length > 0;
    },
    async recordDailyCaptureRun(dateKey, finalizedAt) {
      await client.execute({
        sql: `INSERT INTO daily_capture_runs (date_key, finalized_at)
              VALUES (?, ?)
              ON CONFLICT(date_key) DO UPDATE SET
                finalized_at = excluded.finalized_at,
                updated_at = CURRENT_TIMESTAMP`,
        args: [dateKey, finalizedAt],
      });
    },
    async readBenchmarkPrices(seriesId) {
      const result = await client.execute({
        sql: `SELECT series_id, date, value
              FROM benchmark_prices
              WHERE series_id = ?
              ORDER BY date ASC`,
        args: [seriesId],
      });
      return result.rows.map((row) => toBenchmarkPrice(row));
    },
    async upsertBenchmarkPrices(seriesId, prices) {
      for (const price of prices) {
        await client.execute({
          sql: `INSERT INTO benchmark_prices (series_id, date, value)
                VALUES (?, ?, ?)
                ON CONFLICT(series_id, date) DO UPDATE SET
                  value = excluded.value,
                  updated_at = CURRENT_TIMESTAMP`,
          args: [seriesId, price.dateKey, price.value],
        });
      }
    },
    async recordChatRequest(rateKey, windowKey) {
      // ponytail: stale hourly rows are never purged — ~24 tiny rows/day/key;
      // add a sweep if the table ever matters.
      const result = await client.execute({
        sql: `INSERT INTO chat_usage (rate_key, window_key, count)
              VALUES (?, ?, 1)
              ON CONFLICT(rate_key, window_key) DO UPDATE SET
                count = count + 1,
                updated_at = CURRENT_TIMESTAMP
              RETURNING count`,
        args: [rateKey, windowKey],
      });
      return Number(result.rows[0]?.["count"] ?? 1);
    },
    async readProviderCooldowns(deploymentKey) {
      const result = await client.execute({
        sql: `SELECT provider, cooldown_until
              FROM provider_cooldowns
              WHERE deployment_key = ?
              ORDER BY provider ASC`,
        args: [deploymentKey],
      });
      return result.rows.map((row) => ({
        provider: String(row["provider"]),
        cooldownUntil: String(row["cooldown_until"]),
      }));
    },
    async recordProviderCooldown(deploymentKey, provider, cooldownUntil) {
      await client.execute({
        sql: `INSERT INTO provider_cooldowns
                (deployment_key, provider, cooldown_until)
              VALUES (?, ?, ?)
              ON CONFLICT(deployment_key, provider) DO UPDATE SET
                cooldown_until = MAX(cooldown_until, excluded.cooldown_until),
                updated_at = CURRENT_TIMESTAMP`,
        args: [deploymentKey, provider, cooldownUntil],
      });
    },
    async recordConnectedSourceSync(rateKey, windowKey) {
      const result = await client.execute({
        sql: `INSERT INTO connected_source_sync_usage (rate_key, window_key, count)
              VALUES (?, ?, 1)
              ON CONFLICT(rate_key, window_key) DO UPDATE SET
                count = count + 1,
                updated_at = CURRENT_TIMESTAMP
              RETURNING count`,
        args: [rateKey, windowKey],
      });
      return Number(result.rows[0]?.["count"] ?? 1);
    },
    async recordAssistantCourtesyUse(rateKey, windowKey) {
      // Monthly rows are tiny (≤1/key/month) and self-expire by window key; no sweep needed.
      const result = await client.execute({
        sql: `INSERT INTO assistant_courtesy_usage (rate_key, window_key, count)
              VALUES (?, ?, 1)
              ON CONFLICT(rate_key, window_key) DO UPDATE SET
                count = count + 1,
                updated_at = CURRENT_TIMESTAMP
              RETURNING count`,
        args: [rateKey, windowKey],
      });
      return Number(result.rows[0]?.["count"] ?? 1);
    },
    async recordAiTokenUsage(workspaceId, dayKey, tokens) {
      if (tokens <= 0) return;
      // Two upserts — the workspace's own budget counter and the shared global
      // fuse — so both read a live running total. No transaction: metering is
      // best-effort and overshoot-tolerant, matching the whole increment-then-check
      // contract (ADR 0051). scope_key namespaces the two so a workspace whose id
      // is literally "global" (impossible — ids are `wl-…`) still could not clash.
      const upsert = `INSERT INTO ai_token_usage (scope_key, day_key, tokens)
                      VALUES (?, ?, ?)
                      ON CONFLICT(scope_key, day_key) DO UPDATE SET
                        tokens = tokens + excluded.tokens,
                        updated_at = CURRENT_TIMESTAMP`;
      await client.execute({ sql: upsert, args: [`ws:${workspaceId}`, dayKey, tokens] });
      await client.execute({ sql: upsert, args: ["global", dayKey, tokens] });
    },
    async readAiTokenUsage(workspaceId, dayKey) {
      const result = await client.execute({
        sql: `SELECT scope_key, tokens FROM ai_token_usage
              WHERE day_key = ? AND scope_key IN (?, 'global')`,
        args: [dayKey, `ws:${workspaceId}`],
      });
      let workspaceTokens = 0;
      let globalTokens = 0;
      for (const row of result.rows) {
        const tokens = Number(row["tokens"] ?? 0);
        if (String(row["scope_key"]) === "global") globalTokens = tokens;
        else workspaceTokens = tokens;
      }
      return { workspaceTokens, globalTokens };
    },
    async readRecentGlobalAiTokenUsage(sinceDayKey) {
      const result = await client.execute({
        sql: `SELECT day_key, tokens FROM ai_token_usage
              WHERE scope_key = 'global' AND day_key >= ?
              ORDER BY day_key DESC`,
        args: [sinceDayKey],
      });
      return result.rows.map((row) => ({
        dayKey: String(row["day_key"]),
        tokens: Number(row["tokens"] ?? 0),
      }));
    },
    async listWorkspaceAiTokenUsage(dayKey) {
      const result = await client.execute({
        sql: `SELECT scope_key, tokens FROM ai_token_usage
              WHERE day_key = ? AND scope_key LIKE 'ws:%'`,
        args: [dayKey],
      });
      return result.rows.map((row) => ({
        // scope_key is 'ws:<workspaceId>' — strip the 3-char prefix.
        workspaceId: String(row["scope_key"]).slice(3),
        tokens: Number(row["tokens"] ?? 0),
      }));
    },
    async createGlobalExposureProfile(input) {
      const validated = createValidatedGlobalExposureProfileInput(input);
      const columns = identityColumns(validated.identity);
      const existing = await client.execute({
        sql: "SELECT identity_key FROM global_exposure_profiles WHERE identity_key = ?",
        args: [columns.identityKey],
      });
      if (existing.rows.length > 0) {
        throw new Error("Global exposure profile identity already exists.");
      }

      await client.execute({
        sql: `INSERT INTO global_exposure_profiles (
                identity_key, identity_kind, isin, price_provider, provider_symbol,
                display_name, breakdowns_json, ter, tracked_index, hedged_to_currency
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          columns.identityKey,
          columns.identityKind,
          columns.isin,
          columns.priceProvider,
          columns.providerSymbol,
          validated.displayName,
          JSON.stringify(validated.breakdowns),
          validated.ter,
          validated.trackedIndex,
          validated.hedgedToCurrency,
        ],
      });

      const created = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [columns.identityKey],
      });
      return toGlobalExposureProfile(created.rows[0]!);
    },
    async ensureGlobalExposureProfileStub(identity, displayName) {
      const columns = identityColumns(identity);
      const name = (displayName ?? "").trim() || null;
      // Non-destructive: ON CONFLICT DO NOTHING leaves a pre-existing row (curated
      // data or an earlier stub) exactly as it was — breakdowns default to '{}',
      // the metadata columns to null, the timestamps to CURRENT_TIMESTAMP.
      await client.execute({
        sql: `INSERT INTO global_exposure_profiles (
                identity_key, identity_kind, isin, price_provider, provider_symbol, display_name
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(identity_key) DO NOTHING`,
        args: [
          columns.identityKey,
          columns.identityKind,
          columns.isin,
          columns.priceProvider,
          columns.providerSymbol,
          name,
        ],
      });
    },
    async updateGlobalExposureProfile(identityInput, input) {
      const identity = resolveGlobalExposureProfileIdentity(identityInput);
      const validated = validateGlobalExposureProfileContent(input);
      const identityKey = globalExposureProfileIdentityKey(identity);
      const existing = await client.execute({
        sql: "SELECT created_at FROM global_exposure_profiles WHERE identity_key = ?",
        args: [identityKey],
      });
      if (existing.rows.length === 0) {
        throw new Error("Global exposure profile not found.");
      }

      await client.execute({
        sql: `UPDATE global_exposure_profiles SET
                display_name = ?,
                breakdowns_json = ?,
                ter = ?,
                tracked_index = ?,
                hedged_to_currency = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE identity_key = ?`,
        args: [
          validated.displayName,
          JSON.stringify(validated.breakdowns),
          validated.ter,
          validated.trackedIndex,
          validated.hedgedToCurrency,
          identityKey,
        ],
      });

      const updated = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [identityKey],
      });
      const profile = toGlobalExposureProfile(updated.rows[0]!);
      return {
        ...profile,
        createdAt: String(existing.rows[0]!.created_at),
      };
    },
    async rekeyGlobalExposureProfile(fromInput, toInput) {
      const from = resolveGlobalExposureProfileIdentity(fromInput);
      const to = resolveGlobalExposureProfileIdentity(toInput);
      const fromKey = globalExposureProfileIdentityKey(from);
      const toColumns = identityColumns(to);

      const existing = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [fromKey],
      });
      if (existing.rows.length === 0) {
        throw new Error("Global exposure profile not found.");
      }

      const collision = await client.execute({
        sql: "SELECT identity_key FROM global_exposure_profiles WHERE identity_key = ?",
        args: [toColumns.identityKey],
      });
      if (collision.rows.length > 0) {
        throw new Error("Global exposure profile identity already exists.");
      }

      const current = existing.rows[0]!;
      await client.execute({
        sql: `UPDATE global_exposure_profiles SET
                identity_key = ?,
                identity_kind = ?,
                isin = ?,
                price_provider = ?,
                provider_symbol = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE identity_key = ?`,
        args: [
          toColumns.identityKey,
          toColumns.identityKind,
          toColumns.isin,
          toColumns.priceProvider,
          toColumns.providerSymbol,
          fromKey,
        ],
      });

      const rekeyed = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [toColumns.identityKey],
      });
      const profile = toGlobalExposureProfile(rekeyed.rows[0]!);
      return {
        ...profile,
        createdAt: String(current.created_at),
      };
    },
    async deleteGlobalExposureProfile(identityInput) {
      const identity = resolveGlobalExposureProfileIdentity(identityInput);
      const identityKey = globalExposureProfileIdentityKey(identity);
      await client.execute({
        sql: "DELETE FROM global_exposure_profiles WHERE identity_key = ?",
        args: [identityKey],
      });
    },
    async readGlobalExposureProfile(identityInput) {
      const identity = resolveGlobalExposureProfileIdentity(identityInput);
      const result = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [globalExposureProfileIdentityKey(identity)],
      });
      return result.rows.length > 0 ? toGlobalExposureProfile(result.rows[0]!) : null;
    },
    async readGlobalExposureProfiles() {
      const result = await client.execute(
        `SELECT * FROM global_exposure_profiles
         ORDER BY identity_kind ASC, identity_key ASC`,
      );
      return result.rows.map((row) => toGlobalExposureProfile(row));
    },
    async raiseMaintainerAlert(input) {
      // The open-lookup and the fresh-alert INSERT are two statements: two
      // concurrent raises of the same not-yet-open key can both read "no open
      // row", and the second INSERT then trips `maintainer_alerts_one_open_per_key`.
      // That is the losing raise's cue to accumulate onto the winner's row, not
      // to fail — so a unique violation retries exactly once, where the open
      // lookup now sees the row the winner just minted.
      try {
        return await raiseMaintainerAlertOnce(input);
      } catch (error) {
        if (isOpenKeyConflict(error)) {
          return await raiseMaintainerAlertOnce(input);
        }
        throw error;
      }
    },
    async listMaintainerAlerts() {
      const result = await client.execute(
        `SELECT * FROM maintainer_alerts ORDER BY last_seen_at DESC, rowid DESC`,
      );
      return result.rows.map((row) => toMaintainerAlert(row));
    },
    async getMaintainerAlert(alertId) {
      const alert = await client.execute({
        sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      if (alert.rows.length === 0) return null;
      const occurrences = await client.execute({
        sql: `SELECT id, alert_id, payload_json, occurred_at
              FROM maintainer_alert_occurrences
              WHERE alert_id = ?
              ORDER BY occurred_at ASC, rowid ASC`,
        args: [alertId],
      });
      return {
        ...toMaintainerAlert(alert.rows[0]!),
        occurrences: occurrences.rows.map((row) => toMaintainerAlertOccurrence(row)),
      };
    },
    async updateMaintainerAlertStatus(alertId, { status, note, link }) {
      const existing = await client.execute({
        sql: "SELECT id FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      if (existing.rows.length === 0) {
        throw new Error("Maintainer alert not found.");
      }
      await client.execute({
        sql: `UPDATE maintainer_alerts SET
                status = ?,
                resolution_note = ?,
                resolution_link = ?,
                resolved_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
        args: [status, note ?? null, link ?? null, alertId],
      });
      const updated = await client.execute({
        sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      return toMaintainerAlert(updated.rows[0]!);
    },
    async countOpenMaintainerAlerts() {
      const result = await client.execute(
        "SELECT COUNT(*) AS count FROM maintainer_alerts WHERE status = 'open'",
      );
      return Number(result.rows[0]?.["count"] ?? 0);
    },
    async enqueueJob({
      kind,
      dedupeKey,
      workspaceId,
      payload,
      maxAttempts,
      runAfter,
      now,
    }) {
      const id = newId();
      const stamp = now ?? new Date().toISOString();
      try {
        await client.execute({
          sql: `INSERT INTO job
                  (id, kind, dedupe_key, workspace_id, payload_json, status,
                   attempts, max_attempts, run_after)
                VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
          args: [
            id,
            kind,
            dedupeKey,
            workspaceId ?? null,
            JSON.stringify(payload ?? null),
            maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
            runAfter ?? stamp,
          ],
        });
      } catch (error) {
        // Single-flight: the active-dedupe index rejected the insert because a
        // pending/leased job of this key already exists — collapse onto it.
        if (isJobDedupeConflict(error)) {
          const existing = await client.execute({
            sql: `SELECT * FROM job
                  WHERE dedupe_key = ? AND status IN ('pending', 'leased')
                  LIMIT 1`,
            args: [dedupeKey],
          });
          if (existing.rows.length > 0) {
            return { job: toJob(existing.rows[0]!), enqueued: false };
          }
        }
        throw error;
      }
      const created = await client.execute({
        sql: "SELECT * FROM job WHERE id = ?",
        args: [id],
      });
      return { job: toJob(created.rows[0]!), enqueued: true };
    },
    async leaseJob({ owner, leaseMs, now }) {
      const expiresAt = isoPlusMs(now, leaseMs);
      // Bounded claim loop: pick the oldest ready candidate, then try to claim it
      // with a guarded UPDATE carrying the SAME readiness predicate. If a concurrent
      // worker won the row first, its status is already `leased` with a future
      // expiry, so the predicate no longer matches (0 rows) and we pick the next
      // candidate. Bounded so contention churn can never spin forever.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const candidate = await client.execute({
          sql: `SELECT id FROM job
                WHERE run_after <= ?
                  AND (status = 'pending'
                       OR (status = 'leased' AND lease_expires_at < ?))
                ORDER BY run_after ASC, created_at ASC, rowid ASC
                LIMIT 1`,
          args: [now, now],
        });
        if (candidate.rows.length === 0) return null;
        const id = String(candidate.rows[0]!["id"]);
        const claim = await client.execute({
          sql: `UPDATE job
                SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
                    attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND run_after <= ?
                  AND (status = 'pending'
                       OR (status = 'leased' AND lease_expires_at < ?))`,
          args: [owner, expiresAt, id, now, now],
        });
        if (claim.rowsAffected > 0) {
          const leased = await client.execute({
            sql: "SELECT * FROM job WHERE id = ?",
            args: [id],
          });
          return toJob(leased.rows[0]!);
        }
      }
      return null;
    },
    async renewJobLease({ jobId, owner, leaseMs, now }) {
      const result = await client.execute({
        sql: `UPDATE job SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
        args: [isoPlusMs(now, leaseMs), jobId, owner],
      });
      return result.rowsAffected > 0;
    },
    async completeJob(jobId, owner) {
      await client.execute({
        sql: `UPDATE job
              SET status = 'done', lease_owner = NULL, lease_expires_at = NULL,
                  last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?${owner === undefined ? "" : " AND lease_owner = ?"}`,
        args: owner === undefined ? [jobId] : [jobId, owner],
      });
    },
    async failJob({ jobId, error, now, retryDelayMs, owner }) {
      const existing = await client.execute({
        sql: "SELECT * FROM job WHERE id = ?",
        args: [jobId],
      });
      if (existing.rows.length === 0) {
        throw new Error(`Job "${jobId}" not found.`);
      }
      const job = toJob(existing.rows[0]!);
      // Lost-lease guard: a worker whose lease already lapsed (another worker owns
      // the job now) must not stomp the new owner's state — its failure is a no-op.
      if (owner !== undefined && job.leaseOwner !== owner) {
        return job;
      }
      const canRetry = error.retriable && job.attempts < job.maxAttempts;
      if (canRetry) {
        await client.execute({
          sql: `UPDATE job
                SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
                    run_after = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`,
          args: [isoPlusMs(now, retryDelayMs ?? 0), JSON.stringify(error), jobId],
        });
      } else {
        await client.execute({
          sql: `UPDATE job
                SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL,
                    last_error_json = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`,
          args: [JSON.stringify(error), jobId],
        });
      }
      const updated = await client.execute({
        sql: "SELECT * FROM job WHERE id = ?",
        args: [jobId],
      });
      return toJob(updated.rows[0]!);
    },
    async readJob(jobId) {
      const result = await client.execute({
        sql: "SELECT * FROM job WHERE id = ?",
        args: [jobId],
      });
      return result.rows.length > 0 ? toJob(result.rows[0]!) : null;
    },
    async listJobs() {
      const result = await client.execute(
        "SELECT * FROM job ORDER BY created_at DESC, rowid DESC",
      );
      return result.rows.map((row) => toJob(row));
    },
    close() {
      client.close();
    },
  };
}

function openControlPlaneClient(
  options: ControlPlaneStoreOptions,
  callerName: string,
): Client {
  if (!options.url) {
    throw new Error(`${callerName} requires a url (libsql:// or file:).`);
  }
  const target: LibsqlUrlTarget = {
    url: options.url,
    ...(options.authToken ? { authToken: options.authToken } : {}),
  };
  return openLibsqlClient(target);
}

/**
 * Open the control plane for an ordinary request-scoped consumer: the narrow
 * {@link ControlPlaneStore}, which cannot reach exposure-catalog content writes
 * (#1123). The admin surface uses {@link createAdminControlPlaneStore} instead.
 */
export async function createControlPlaneStore(
  options: ControlPlaneStoreOptions = {},
): Promise<ControlPlaneStore> {
  return buildControlPlaneStore(
    openControlPlaneClient(options, "createControlPlaneStore"),
    options.newId ?? randomUUID,
  );
}

/**
 * Open the control plane with exposure-catalog curation writes (#1123) — the
 * `/admin` surface's opener. Identical wiring to {@link createControlPlaneStore},
 * only the wider {@link AdminControlPlaneStore} type.
 */
export async function createAdminControlPlaneStore(
  options: ControlPlaneStoreOptions = {},
): Promise<AdminControlPlaneStore> {
  return buildControlPlaneStore(
    openControlPlaneClient(options, "createAdminControlPlaneStore"),
    options.newId ?? randomUUID,
  );
}

/**
 * Open an ephemeral in-memory control plane — for tests. Returns the wide
 * {@link AdminControlPlaneStore} so persistence tests can exercise catalog
 * curation writes directly.
 */
export async function createInMemoryControlPlaneStore(
  options: Pick<ControlPlaneStoreOptions, "newId"> = {},
): Promise<AdminControlPlaneStore> {
  return buildControlPlaneStore(
    openLibsqlClient(":memory:"),
    options.newId ?? randomUUID,
  );
}

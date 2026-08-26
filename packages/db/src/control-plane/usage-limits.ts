import type { Client } from "@libsql/client";

/**
 * Tables owned by the usage port (ADR 0051): the rate counters every serverless
 * instance of one deployment shares, the provider cooldowns, and the two daily
 * meters (assistant tokens #1163, vision calls #1258).
 */
export const USAGE_SCHEMA = `
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
CREATE TABLE IF NOT EXISTS mcp_usage (
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
-- Attachment extraction meter (#1258): vision model CALLS per scope per UTC day,
-- the eager extractors' own counter. Separate table from ai_token_usage on
-- purpose: that one means the conversational turn (#1163), this one the one-shot
-- ingestion cost, and the two must never interfere. scope_key is 'global' (the
-- shared daily fuse), 'ws:<workspaceId>' or 'demo:<ip>'. Same tiny self-expiring
-- rows; no sweep.
CREATE TABLE IF NOT EXISTS vision_call_usage (
  scope_key TEXT NOT NULL,
  day_key TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope_key, day_key)
);
`;

export interface ProviderCooldown {
  provider: string;
  cooldownUntil: string;
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
 * The day's accumulated vision-extraction readings read by the pre-extraction
 * gate (#1258): this scope's own calls (against its daily allowance) and the
 * shared global total (against the daily fuse). Zero when a scope has no row yet.
 */
export interface VisionCallUsage {
  scopeCalls: number;
  globalCalls: number;
}

/** One day's GLOBAL vision-call total — the extraction spend series for /admin (#1258). */
export interface VisionCallDailyUsage {
  dayKey: string;
  calls: number;
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
   * Count one MCP or Auth.js OAuth callback request (#1183). Same increment-then-check
   * contract as chat usage, but in a separate table so MCP/OAuth quotas cannot
   * interfere with the assistant counter.
   */
  recordMcpRequest(rateKey: string, windowKey: string): Promise<number>;
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
  /**
   * Add `calls` vision-extraction readings to BOTH this scope's and the shared
   * global daily counters (#1258) for `dayKey` (UTC "YYYY-MM-DD"). `scopeKey`
   * arrives fully formed — `ws:<workspaceId>` or `demo:<ip>` — because the eager
   * extractor is reachable by an anonymous demo caller, which the token meter's
   * workspace-only scope could not express.
   *
   * The unit is CALLS, not tokens: the extractor's contract hands back validated
   * JSON and never provider usage, so counting readings is what this seam can
   * honestly count — and it is enough for a fuse, because a reading is bounded
   * (4 MiB, 20 pages) and therefore so is its cost. Aggregate only, never any
   * content (#1131). Recorded AFTER the reading, so a caller may overshoot by one
   * turn before the next is refused — the ADR 0051 increment-then-check tolerance.
   */
  recordVisionCalls(scopeKey: string, dayKey: string, calls: number): Promise<void>;
  /**
   * The day's accumulated readings for the pre-extraction gate (#1258): this
   * scope's own calls (against its daily allowance) and the global shared total
   * (against the daily fuse). Zero for a scope with no row yet.
   */
  readVisionCallUsage(scopeKey: string, dayKey: string): Promise<VisionCallUsage>;
  /**
   * Global daily vision-call totals from `sinceDayKey` onward (inclusive), newest
   * first — the extraction spend series /admin renders (#1258). Global scope only;
   * no per-scope rows, so no demo IP ever leaves the control plane.
   */
  readRecentGlobalVisionCallUsage(sinceDayKey: string): Promise<VisionCallDailyUsage[]>;
}

export function createUsageLimits(client: Client): UsageLimits {
  return {
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
    async recordMcpRequest(rateKey, windowKey) {
      const result = await client.execute({
        sql: `INSERT INTO mcp_usage (rate_key, window_key, count)
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
    async recordVisionCalls(scopeKey, dayKey, calls) {
      if (calls <= 0) return;
      // Same two-upsert, no-transaction shape as the token meter: the scope's own
      // allowance and the shared fuse both read a live running total, and metering
      // stays best-effort and overshoot-tolerant (ADR 0051). The guard matters here
      // in a way it does not there: this port takes the scope key already formed,
      // so a caller passing 'global' would otherwise count itself twice and blow
      // the fuse at half the real usage.
      const upsert = `INSERT INTO vision_call_usage (scope_key, day_key, calls)
                      VALUES (?, ?, ?)
                      ON CONFLICT(scope_key, day_key) DO UPDATE SET
                        calls = calls + excluded.calls,
                        updated_at = CURRENT_TIMESTAMP`;
      await client.execute({ sql: upsert, args: [scopeKey, dayKey, calls] });
      if (scopeKey !== "global") {
        await client.execute({ sql: upsert, args: ["global", dayKey, calls] });
      }
    },
    async readVisionCallUsage(scopeKey, dayKey) {
      const result = await client.execute({
        sql: `SELECT scope_key, calls FROM vision_call_usage
              WHERE day_key = ? AND scope_key IN (?, 'global')`,
        args: [dayKey, scopeKey],
      });
      let scopeCalls = 0;
      let globalCalls = 0;
      for (const row of result.rows) {
        const calls = Number(row["calls"] ?? 0);
        if (String(row["scope_key"]) === "global") globalCalls = calls;
        if (String(row["scope_key"]) === scopeKey) scopeCalls = calls;
      }
      return { scopeCalls, globalCalls };
    },
    async readRecentGlobalVisionCallUsage(sinceDayKey) {
      const result = await client.execute({
        sql: `SELECT day_key, calls FROM vision_call_usage
              WHERE scope_key = 'global' AND day_key >= ?
              ORDER BY day_key DESC`,
        args: [sinceDayKey],
      });
      return result.rows.map((row) => ({
        dayKey: String(row["day_key"]),
        calls: Number(row["calls"] ?? 0),
      }));
    },
  };
}

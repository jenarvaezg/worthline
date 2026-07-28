import { type CallerScope, callerScope } from "@web/asistente/caller-scope";
import type { StoreTarget } from "@web/store-resolver";

/**
 * The eager extractor's own money fuse (#1258) — the counter #1163 deliberately
 * did not build.
 *
 * The vision seam (ADR 0063) calls a paid provider BEFORE the conversational turn
 * and outside every fuse that existed: `meterAssistantStream` meters the turn
 * (its contract hands back validated JSON, never provider usage, so there are no
 * tokens to read), the per-plan token budget and the global token fuse are fed by
 * that same meter, and `demo` resolves to `premium` so the ingestion paywall never
 * fires for an anonymous visitor. #1246 then made an unidentified attachment cost
 * TWO vision calls instead of one, with the caller choosing whether to pay: any
 * non-financial image lands on the descriptive cascade. That is a spend path no
 * counter could see.
 *
 * This is the second counter the issue asked for, deliberately NOT the token one:
 * the unit here is CALLS, and the semantics of `token-metering.ts` (a conversational
 * turn is the recurring cost) stay exactly as #1163 wrote them. Counting calls is
 * both what this seam can honestly count and enough for a fuse, because ONE reading
 * is bounded by the extraction contract — 4 MiB and 20 PDF pages — so a bounded
 * number of bounded readings is a bounded bill.
 *
 * Pure policy: scope selection, window bucketing and thresholds, so it unit-tests
 * without a database. The counter itself lives in the control plane
 * (`vision-call-budget-store.ts`), like every other serverless-shared limit
 * (ADR 0051). Increment-then-check, and the increment lands after the response
 * (`after()`), so the overshoot is not one turn but everything a caller can start
 * before its first write lands — bounded by the hourly rate limit above it, which
 * is what keeps «a few readings over» from becoming «a day's worth». The same
 * tolerance the rate limit and the token meter carry, stated honestly.
 */

/**
 * Daily readings allowed per scope, and the shared fuse over all of them.
 *
 * Denominated in readings because that is what a caller triggers: an identified
 * document costs one, an unidentified one costs two (#1246). The figures are
 * operational anti-abuse backstops, not pricing — safe to tune here.
 *
 * `workspace`: 60 readings is 60 documents a day, or 30 of the worst kind. The
 * heaviest honest day imaginable — onboarding a household's statements — is well
 * inside it, while the hourly chat limit alone (30 requests/hour, ADR 0051) would
 * have allowed an order of magnitude more.
 *
 * `demo`: an anonymous visitor gets enough to try the feature (6 unidentified
 * uploads) and no more. It is the scope with no plan behind it and no identity to
 * hold accountable, so it gets the shortest rope.
 *
 * `global`: the catastrophe cap. A bounded reading of the largest accepted file is
 * a few thousand input tokens on the fixed low-cost extractor model, so a spent
 * global fuse is a spend of cents — which is the point: the hole was never the
 * amount, it was that nothing bounded it.
 *
 * Demo readings feed the global fuse, unlike demo turns and the token fuse (which
 * demo bypasses entirely). That is deliberate — the anonymous surface is the one
 * with no plan behind it, so leaving it outside the aggregate cap would leave the
 * biggest hole exactly where the issue found it — and it has a price: a botnet
 * spread over ~50 IPs, each spending its 12, can blow the shared fuse and pause
 * document reading for paying workspaces until the next UTC day. An honest
 * degradation under attack, and a far better failure than an unbounded bill; if it
 * ever bites in practice, the next lever is a demo-wide daily bucket under the fuse,
 * mirroring the demo-wide hourly one the rate limit already keeps (#1184).
 */
export const VISION_CALL_LIMITS = {
  /** Authenticated usage, per workspace, per UTC day. */
  workspace: 60,
  /** Demo or unauthenticated usage, per IP, per UTC day. */
  demo: 12,
  /** Every scope combined, per UTC day: the shared backstop. */
  global: 600,
} as const;

export type VisionCallPlan =
  | { mode: "count"; scopeKey: string; dailyLimit: number }
  | Extract<CallerScope, { mode: "bypass" }>;

/** The ISO timestamp's UTC calendar-day bucket, e.g. "2026-07-28". */
export function visionCallDayWindow(nowIso: string): string {
  return nowIso.slice(0, 10);
}

/**
 * Which counter this caller's readings land in, and how many it may have — or
 * bypass for the local single-user target, where the developer owns the key
 * (ADR 0051). The key comes from `callerScope`, the same one the rate limit uses,
 * so a workspace is the same workspace to every meter; only the allowance is this
 * module's.
 */
export function visionCallPlan(target: StoreTarget, ip: string | null): VisionCallPlan {
  const scope = callerScope(target, ip);
  if (scope.mode === "bypass") return scope;
  return {
    mode: "count",
    scopeKey: scope.key,
    dailyLimit:
      target.kind === "authenticated"
        ? VISION_CALL_LIMITS.workspace
        : VISION_CALL_LIMITS.demo,
  };
}

/**
 * Has this scope spent its daily readings? Compares what is ALREADY recorded
 * against the allowance: once cumulative usage reaches it, the next attachment is
 * refused (the crossing reading is allowed to finish — recording is post-hoc).
 */
export function isVisionCallBudgetExhausted(
  usedCalls: number,
  dailyLimit: number,
): boolean {
  return usedCalls >= dailyLimit;
}

/** Has the shared global daily fuse blown? Applies to every scope, demo included. */
export function isGlobalVisionCallFuseBlown(globalCalls: number): boolean {
  return globalCalls >= VISION_CALL_LIMITS.global;
}

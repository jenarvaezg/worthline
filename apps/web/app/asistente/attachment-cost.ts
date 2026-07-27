import type { AttachmentExtractionResult } from "@web/asistente/attachment-extraction-contract";
import { chatRateWindow } from "@web/asistente/rate-limit";
import type { StoreTarget } from "@web/store-resolver";

/**
 * The money fuse over the vision extractor (#1258). Until this existed, the eager
 * extractors were the one path to a paid provider that NO counter watched:
 *
 *  - they call Google with the key directly, so ADR 0050's Gateway spend ceiling —
 *    which is not wired in production anyway (see ADR 0051's note) — covers nothing;
 *  - the token meter deliberately scopes itself to the conversational turn (#1163),
 *    so neither the workspace budget nor the global fuse can ever bite on extraction;
 *  - `demo` resolves to `premium`, so the ingestion paywall does not gate an
 *    anonymous visitor's uploads either.
 *
 * What was left was the hourly chat rate limit — a bound on TURNS, not on readings,
 * and #1246 broke the equivalence between them: an attachment whose document the seam
 * does not identify now pays a SECOND descriptive vision call, and the caller decides
 * which one it is by choosing the file. So the unit counted here is the **vision call**,
 * not the attachment and not the turn.
 *
 * Deliberately its own counter, per the #1163 boundary: `token-metering.ts` keeps
 * meaning «the recurring conversational cost», and this one means «what one-shot
 * ingestion spent». Mixing them would have made both unreadable.
 *
 * Pure policy — keys, ceilings, windows — so it unit-tests without a database; the
 * counter itself lives in the control plane (`attachment-cost-store.ts`).
 */

/**
 * Vision calls allowed per fixed UTC hour. Well above any real session and far below
 * a bill: a person tracking their portfolio attaches a handful of documents and reads
 * the answer; a script feeding unidentifiable images pays two calls each and reaches
 * the ceiling in minutes.
 *
 * Both demo ceilings are much tighter because demo ingestion is anonymous and free:
 * it is the surface with no identity behind it, and the one #1258 flagged first.
 * Operational anti-abuse backstops, not pricing — safe to tune here.
 */
export const VISION_CALL_LIMITS = {
  /** Authenticated usage, per workspace, per hour. */
  workspace: 15,
  /** Anonymous demo usage, per IP, per hour. */
  demo: 4,
  /**
   * Demo traffic aggregate, all IPs combined, per hour — a botnet cannot multiply the
   * per-IP one. It is shared fate on purpose, the same trade-off #1184 made for demo
   * turns: one abuser can leave the demo unable to read files for the rest of the
   * hour, and that is preferable to an unbounded bill on an anonymous surface. Sized
   * to sit under the 60 demo turns/hour that limit already allows.
   */
  demoGlobal: 40,
} as const;

/** Whose money a bucket guards. Log this, never the key — a demo key carries an IP. */
export type VisionCallScope = "workspace" | "demo-ip" | "demo-global" | "ip";

/** One counter this caller answers to: its control-plane key and its hourly ceiling. */
export interface VisionCallBucket {
  key: string;
  limit: number;
  scope: VisionCallScope;
}

/**
 * The counters this caller's extraction spends from — empty for the local
 * single-user target, where the developer owns the key (ADR 0051's bypass).
 *
 * Demo answers to two at once, mirroring the chat rate limit (#1184): its own IP and
 * the shared demo bucket. `unauthenticated` never reaches the chat route (it is
 * refused with a 401 first) but is keyed anyway, so a future caller cannot land here
 * unmetered by omission.
 */
export function visionCallBuckets(
  target: StoreTarget,
  ip: string | null,
): readonly VisionCallBucket[] {
  switch (target.kind) {
    case "local":
      return [];
    case "authenticated":
      return [
        {
          key: `ws:${target.workspaceId}`,
          limit: VISION_CALL_LIMITS.workspace,
          scope: "workspace",
        },
      ];
    case "demo":
      return [
        {
          key: `demo:${ip ?? "unknown"}`,
          limit: VISION_CALL_LIMITS.demo,
          scope: "demo-ip",
        },
        {
          key: "demo:global",
          limit: VISION_CALL_LIMITS.demoGlobal,
          scope: "demo-global",
        },
      ];
    case "unauthenticated":
      return [
        { key: `ip:${ip ?? "unknown"}`, limit: VISION_CALL_LIMITS.demo, scope: "ip" },
      ];
  }
}

/**
 * The same fixed UTC-hour window as the ADR 0051 rate limit, so a caller stopped by
 * either one rolls over at the same moment and the two never disagree about "an hour".
 * A distinct name because it addresses a distinct counter and a distinct table.
 */
export function visionCallWindow(nowIso: string): string {
  return chatRateWindow(nowIso);
}

/**
 * Has this caller spent its extraction budget for the window? True as soon as ANY
 * bucket is at or above its ceiling. `counts` is keyed by rate key — deliberately not
 * a positional array beside `buckets`, because a money fuse whose two lists can drift
 * out of step fails OPEN, and a key with no row honestly means zero.
 *
 * Read-then-check, so the cost of the reading about to run is not known yet: a caller
 * one call short of the ceiling may cross it by a whole attachment before the next one
 * is refused, and two uploads racing each other may both read the same count. The same
 * overshoot tolerance the token meter documents (#1163) — the fuse bounds a sustained
 * abuse, not a single attachment.
 */
export function isVisionCallBudgetSpent(
  buckets: readonly VisionCallBucket[],
  counts: Readonly<Record<string, number>>,
): boolean {
  return buckets.some((bucket) => (counts[bucket.key] ?? 0) >= bucket.limit);
}

/**
 * What the user reads when the fuse blows. Not a 429 that kills the turn: the
 * attachment is simply not read, the card says so honestly, and the conversation
 * continues — the same #1242 contract every other unread attachment follows, so the
 * model can offer the manual route instead of the user hitting a wall.
 */
export const VISION_BUDGET_SPENT_FAILURE = {
  code: "extractor_budget_spent",
  failure: "transient",
  message:
    "He leído bastantes archivos en la última hora y necesito parar un rato. Puedes contarme por escrito lo que pone y seguimos.",
  status: "failure",
} as const satisfies AttachmentExtractionResult;

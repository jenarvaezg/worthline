/**
 * The chat route's quota doors, in the order they must be tried (#1697, extracted
 * from `route.ts`).
 *
 * There are five of them and their ORDER is semantically load-bearing, which is the
 * whole reason this is one module and one function rather than five checks inlined in
 * a 500-line handler: the order used to live in comments only. Read
 * {@link openTurnSpendDoors} downwards and the cascade IS the specification.
 *
 * Every reading is injected ({@link TurnSpendReaders}) so a door can be exercised on
 * its own — no request, no store, no provider, no model. The route passes
 * {@link REAL_TURN_SPEND_READERS}; `chat-quota-gates.test.ts` passes fakes.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: turn a verdict into a `Response`. The
 * distinction between a 4xx and a streamed 200 paywall is the route's (see
 * `chat-responses.ts`), and keeping it out here is what lets the cascade be asserted
 * as data — which copy, which status — instead of by reading a stream.
 */

import { attachmentTooLarge } from "@web/api/chat/chat-request-body";
import { isVisionAttachment } from "@web/asistente/attachment-turn";
import {
  courtesyMonthWindow,
  isCourtesyQuotaExhausted,
} from "@web/asistente/courtesy-quota";
import { countAssistantCourtesyUse } from "@web/asistente/courtesy-quota-store";
import {
  chatRatePlan,
  chatRateWindow,
  demoGlobalRatePlan,
} from "@web/asistente/rate-limit";
import { countChatRequest } from "@web/asistente/rate-limit-store";
import {
  isGlobalTokenFuseBlown,
  isWorkspaceTokenBudgetExhausted,
  tokenDayWindow,
} from "@web/asistente/token-budget";
import { readAiTokenUsage, recordAiTokenUsage } from "@web/asistente/token-budget-store";
import {
  type MaybeFinishPart,
  meterAssistantStream,
} from "@web/asistente/token-metering";
import {
  isGlobalVisionCallFuseBlown,
  isVisionCallBudgetExhausted,
  type VisionCallPlan,
  visionCallDayWindow,
  visionCallPlan,
} from "@web/asistente/vision-call-budget";
import {
  readVisionCallUsage,
  recordVisionCalls,
} from "@web/asistente/vision-call-budget-store";
import { isPremiumIngestionAllowed } from "@web/entitlements/effective-plan";
import {
  PAYWALL_ATTACHMENT_MESSAGE,
  PAYWALL_COURTESY_MESSAGE,
  PAYWALL_GLOBAL_FUSE_MESSAGE,
  PAYWALL_TOKEN_BUDGET_MESSAGE,
  PAYWALL_VISION_BUDGET_MESSAGE,
  PAYWALL_VISION_FUSE_MESSAGE,
} from "@web/entitlements/paywall-copy";
import { readEffectivePlan } from "@web/entitlements/read-effective-plan";
import type { StoreTarget } from "@web/store-resolver";
import type { EntitlementPlan } from "@worthline/db";
import { after } from "next/server";

import { operationalCause } from "./chat-responses";

/** The vision scope that actually counts, carried through to the recording. */
export type MeteredVisionScope = Extract<VisionCallPlan, { mode: "count" }>;

/** Every control-plane reading the doors consult, injected so each can be faked. */
export interface TurnSpendReaders {
  countAssistantCourtesyUse(rateKey: string, monthKey: string): Promise<number | null>;
  readAiTokenUsage(
    workspaceId: string,
    dayKey: string,
  ): Promise<{ globalTokens: number; workspaceTokens: number } | null>;
  readEffectivePlan(target: StoreTarget, nowIso: string): Promise<EntitlementPlan>;
  readVisionCallUsage(
    scopeKey: string,
    dayKey: string,
  ): Promise<{ globalCalls: number; scopeCalls: number } | null>;
}

export const REAL_TURN_SPEND_READERS: TurnSpendReaders = {
  countAssistantCourtesyUse,
  readAiTokenUsage,
  readEffectivePlan,
  readVisionCallUsage,
};

export interface TurnSpendInput {
  attachment: File | null;
  ip: string | null;
  nowIso: string;
  target: StoreTarget;
}

/**
 * What the cascade decided.
 *
 * `open` carries what the doors already had to compute, so the route never reads the
 * plan twice: the ingestion flag the chat tools take (PRD #1241) and the vision scope
 * the reading must be charged to.
 */
export type TurnSpendVerdict =
  | {
      kind: "open";
      ingestionAllowed: boolean;
      visionMeter: MeteredVisionScope | null;
    }
  | { kind: "paywall"; message: string }
  | { kind: "refused"; error: string; status: number };

/**
 * Which counter this turn's readings land in, or `null` when there is nothing to meter.
 *
 * Null for no attachment, for a spreadsheet (the deterministic route never reaches a
 * model, so braking one would refuse a free upload with a message about a cost it does
 * not have), or for the local target where the developer owns the key (ADR 0051). It
 * carries the scope through to the recording, so the gate and the counter can never
 * disagree on the key.
 */
export function visionMeterFor(input: {
  attachment: File | null;
  ip: string | null;
  target: StoreTarget;
}): MeteredVisionScope | null {
  const { attachment } = input;
  if (!attachment) return null;
  if (!isVisionAttachment({ fileName: attachment.name, mimeType: attachment.type })) {
    return null;
  }
  const plan = visionCallPlan(input.target, input.ip);
  return plan.mode === "count" ? plan : null;
}

/**
 * The abuse door, and the FIRST one that costs the caller anything (ADR 0051): counted
 * per caller, plus a shared hourly budget for the demo. It runs before the multipart
 * body is even parsed, so a hostile uploader cannot make the route materialize 4 MiB
 * per request just to be told it is over its limit.
 */
export async function chatRateLimitReached(
  input: { ip: string | null; nowIso: string; target: StoreTarget },
  count: (
    rateKey: string,
    windowKey: string,
  ) => Promise<number | null> = countChatRequest,
): Promise<boolean> {
  const { ip, nowIso, target } = input;
  const plan = chatRatePlan(target, ip);
  const rateWindow = chatRateWindow(nowIso);
  if (plan.mode === "count") {
    const counted = await count(plan.key, rateWindow);
    if (counted !== null && counted > plan.limit) return true;
  }
  if (target.kind === "demo") {
    const globalPlan = demoGlobalRatePlan();
    const globalCount = await count(globalPlan.key, rateWindow);
    if (globalCount !== null && globalCount > globalPlan.limit) return true;
  }
  return false;
}

/**
 * The five spend doors of one turn, in the ONE order they may be tried.
 *
 * The order, and why each step sits where it does:
 *
 *  1. **Premium ingestion** (PRD #1160 S2, #1162). A free workspace cannot have the
 *     machine read a document for it — but every figure it typed stays free. Honest
 *     reminder, no courtesy turn charged. First, because it is the only door that
 *     depends on nothing but the plan.
 *  2. **AI token fuse, then the workspace budget** (PRD #1160 S3, #1163). Counted per
 *     UTC day in the control plane and checked BEFORE the model call — so the eager
 *     extractor degrades honestly too, running only after this gate. The fuse applies
 *     to every authenticated caller; the per-plan workspace budget bites only
 *     trial/premium (free is bounded by the courtesy quota below, not tokens). A null
 *     read is unmetered (local dev) — the pure predicates never fire. demo/local
 *     deliberately bypass the meter, exactly as the ingestion gate does: demo is
 *     IP-rate-limited plus a shared hourly global budget (#1184, ADR 0051), its
 *     provider spend is backstopped by the Gateway money ceiling (ADR 0050), and local
 *     dev owns its own key.
 *  3. **The free plan's monthly courtesy quota** (ADR 0051 mechanism). Only
 *     authenticated free turns that reach the model count; trial/premium answer to the
 *     token budget, demo/local bypass entirely.
 *  4. **The oversized upload** (#1180), on its DECLARED size, before `arrayBuffer()`
 *     materializes the whole body in the JS heap. It sits AFTER the paywalls on
 *     purpose: a caller who has already spent their allowance reads about the
 *     allowance, not about the file.
 *  5. **The eager extractor's own money fuse** (#1258). Every gate above is blind to
 *     it: the vision seam calls a paid provider BEFORE the conversational turn, its
 *     contract returns validated JSON and never provider usage (so the token meter has
 *     nothing to read), and `demo` resolves to `premium`, so the ingestion paywall does
 *     not fire for an anonymous visitor either. #1246 then doubled the worst case — an
 *     unidentified attachment costs two vision calls, and the caller chooses whether to
 *     pay by uploading something the seam cannot type. So: its OWN daily counter, in
 *     calls, checked here before a byte is read and recorded after the reading.
 *     Nothing about `token-metering.ts` changes — that one still means the
 *     conversational turn (#1163).
 */
export async function openTurnSpendDoors(
  input: TurnSpendInput,
  readers: TurnSpendReaders = REAL_TURN_SPEND_READERS,
): Promise<TurnSpendVerdict> {
  const { attachment, ip, nowIso, target } = input;

  const effectivePlan = await readers.readEffectivePlan(target, nowIso);
  const ingestionAllowed = isPremiumIngestionAllowed(effectivePlan);
  if (attachment && !ingestionAllowed) {
    return { kind: "paywall", message: PAYWALL_ATTACHMENT_MESSAGE };
  }

  if (target.kind === "authenticated") {
    const usage = await readers.readAiTokenUsage(
      target.workspaceId,
      tokenDayWindow(nowIso),
    );
    if (usage && isGlobalTokenFuseBlown(usage.globalTokens)) {
      return { kind: "paywall", message: PAYWALL_GLOBAL_FUSE_MESSAGE };
    }
    if (usage && isWorkspaceTokenBudgetExhausted(usage.workspaceTokens, effectivePlan)) {
      return { kind: "paywall", message: PAYWALL_TOKEN_BUDGET_MESSAGE };
    }
  }

  if (target.kind === "authenticated" && effectivePlan === "free") {
    const used = await readers.countAssistantCourtesyUse(
      `ws:${target.workspaceId}`,
      courtesyMonthWindow(nowIso),
    );
    if (isCourtesyQuotaExhausted(used)) {
      return { kind: "paywall", message: PAYWALL_COURTESY_MESSAGE };
    }
  }

  if (attachmentTooLarge(attachment)) {
    return { kind: "refused", error: "attachment_too_large", status: 413 };
  }

  const visionMeter = visionMeterFor({ attachment, ip, target });
  if (visionMeter) {
    const usage = await readers.readVisionCallUsage(
      visionMeter.scopeKey,
      visionCallDayWindow(nowIso),
    );
    if (usage && isGlobalVisionCallFuseBlown(usage.globalCalls)) {
      return { kind: "paywall", message: PAYWALL_VISION_FUSE_MESSAGE };
    }
    if (usage && isVisionCallBudgetExhausted(usage.scopeCalls, visionMeter.dailyLimit)) {
      return { kind: "paywall", message: PAYWALL_VISION_BUDGET_MESSAGE };
    }
  }

  return { kind: "open", ingestionAllowed, visionMeter };
}

/**
 * Charge this reading's vision calls to the scope the gate above chose.
 *
 * After the response, like the token meter: the reading is already paid for, and the
 * user must not wait on a control-plane write to see their card.
 */
export function recordTurnVisionCalls(
  visionMeter: MeteredVisionScope | null,
  nowIso: string,
  visionCalls: number,
): void {
  if (!visionMeter || visionCalls <= 0) return;
  const { scopeKey } = visionMeter;
  const dayKey = visionCallDayWindow(nowIso);
  after(async () => {
    try {
      await recordVisionCalls(scopeKey, dayKey, visionCalls);
    } catch (error) {
      console.error("Assistant vision call metering write failed", {
        operation: "write",
        cause: operationalCause(error),
      });
    }
  });
}

/**
 * Tap the turn's stream so its tokens can be recorded once it finishes (PRD #1160 S3,
 * #1163).
 *
 * The count is only known at the finish part — after we have begun streaming — so the
 * stream is wrapped and the write scheduled with `after()`, never blocking the reply.
 * Gated on a real control plane so local dev and the route tests stay unmetered, which
 * is also why the untapped stream is returned unchanged rather than metered into a
 * no-op.
 */
export function meterTurnTokens<Part extends MaybeFinishPart>(
  stream: ReadableStream<Part>,
  workspaceId: string | null,
  nowIso: string,
): ReadableStream<Part> {
  if (workspaceId === null || !process.env["WORTHLINE_CONTROL_PLANE_DB_URL"]) {
    return stream;
  }
  const metered = meterAssistantStream(stream);
  const dayKey = tokenDayWindow(nowIso);
  after(async () => {
    const tokens = await metered.totalTokens;
    if (tokens <= 0) return;
    try {
      await recordAiTokenUsage(workspaceId, dayKey, tokens);
    } catch (error) {
      console.error("Assistant token metering write failed", {
        operation: "write",
        cause: operationalCause(error),
      });
    }
  });
  return metered.stream;
}

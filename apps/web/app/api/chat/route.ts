import { chatAsOf } from "@web/asistente/chat-clock";
import { resolveChatModels } from "@web/asistente/chat-model";
import { createChatTools } from "@web/asistente/chat-tools";
import {
  classifyPreOutputProviderError,
  streamWithProviderFailover,
} from "@web/asistente/provider-failover";
import { chatRatePlan, chatRateWindow } from "@web/asistente/rate-limit";
import { countChatRequest } from "@web/asistente/rate-limit-store";
import { isScreenContext, type ScreenContext } from "@web/asistente/screen-context";
import { buildChatSystemPrompt } from "@web/asistente/system-prompt";
import { readStoreTarget } from "@web/read-store-target";
import { withStore } from "@web/store";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { NextResponse } from "next/server";

/**
 * The assistant's chat route (#629) — the spine of PRD #627. Streams model
 * output over the AI SDK, grounded by chat tools that only ever see the
 * agent-view read store (ADR 0047; writes impossible by construction, ADR
 * 0044). Ephemeral: the client sends the whole conversation each turn and
 * nothing is persisted. Rate limit runs BEFORE any provider call (ADR 0051).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_MESSAGES = 40;
const MAX_TOTAL_CHARS = 16_000;
/** Read tool + suggest_actions (#631) + answer, with one step of headroom. */
const MAX_STEPS = 4;

interface ChatBody {
  messages: UIMessage[];
  screenContext: ScreenContext | null;
}

function parseChatBody(raw: unknown): ChatBody | null {
  if (raw === null || typeof raw !== "object") return null;

  const { messages, screenContext } = raw as {
    messages?: unknown;
    screenContext?: unknown;
  };
  if (!Array.isArray(messages) || messages.length === 0) return null;
  if (messages.length > MAX_MESSAGES) return null;
  if (JSON.stringify(messages).length > MAX_TOTAL_CHARS) return null;
  const shapedLikeUIMessages = messages.every(
    (m) =>
      m !== null &&
      typeof m === "object" &&
      Array.isArray((m as { parts?: unknown }).parts),
  );
  if (!shapedLikeUIMessages) return null;

  return {
    messages: messages as UIMessage[],
    screenContext: isScreenContext(screenContext) ? screenContext : null,
  };
}

function clientIp(request: Request): string | null {
  // x-real-ip is platform-set on Vercel; the RIGHTMOST forwarded hop is the
  // one appended by the proxy. The leftmost is client-controlled — keying the
  // rate limit on it would let a caller mint fresh buckets per request.
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",").at(-1)?.trim() || null;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError("invalid_body", 400);
  }
  const body = parseChatBody(raw);
  if (!body) {
    return jsonError("invalid_body", 400);
  }

  const target = await readStoreTarget();
  if (target.kind === "unauthenticated") {
    return jsonError("unauthenticated", 401);
  }

  // Config check first: a misconfigured deploy must not burn callers' quota.
  const providers = resolveChatModels();
  if (providers.length === 0) {
    return jsonError("assistant_unavailable", 503);
  }

  const plan = chatRatePlan(target, clientIp(request));
  if (plan.mode === "count") {
    const count = await countChatRequest(
      plan.key,
      chatRateWindow(new Date().toISOString()),
    );
    if (count !== null && count > plan.limit) {
      return jsonError("rate_limited", 429);
    }
  }

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(body.messages);
  } catch {
    return jsonError("invalid_body", 400);
  }

  const system = buildChatSystemPrompt(body.screenContext);
  const tools = createChatTools({
    runWithStore: (run) =>
      withStore((store) => run({ agentView: store.agentView }), target),
    asOf: chatAsOf(target),
  });
  const selected = await streamWithProviderFailover({
    providers,
    startStream: (provider) =>
      streamText({
        model: provider.model,
        system,
        messages: modelMessages,
        tools,
        stopWhen: isStepCount(MAX_STEPS),
        // Cross-provider failover is the retry policy for a rejected request.
        // Retrying the same 429 first would delay request-too-large failover.
        maxRetries: 0,
        // AI SDK's default callback logs the complete APICallError, including
        // requestBodyValues. Attempt and stream logs below are sanitized.
        onError: () => undefined,
      }).stream,
    log: (entry) => console.info("Assistant provider attempt", entry),
  });
  if (selected === null) {
    return jsonError("assistant_unavailable", 503);
  }

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: selected.stream,
      onError: (error) => {
        console.error("Chat stream failed", {
          provider: selected.provider.provider,
          modelId: selected.provider.modelId,
          classification: classifyPreOutputProviderError(error) ?? "provider_error",
        });
        return "provider_error";
      },
    }),
    headers: NO_STORE,
  });
}

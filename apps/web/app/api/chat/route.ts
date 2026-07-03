import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { NextResponse } from "next/server";

import { resolveChatModel } from "@web/asistente/chat-model";
import { createChatTools } from "@web/asistente/chat-tools";
import { chatRatePlan, chatRateWindow } from "@web/asistente/rate-limit";
import { countChatRequest } from "@web/asistente/rate-limit-store";
import { isScreenContext, type ScreenContext } from "@web/asistente/screen-context";
import { buildChatSystemPrompt } from "@web/asistente/system-prompt";
import { readStoreTarget } from "@web/read-store-target";
import { withStore } from "@web/store";

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
/** Tool step + answer step, with one retry step of headroom. */
const MAX_STEPS = 3;

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

  return {
    messages: messages as UIMessage[],
    screenContext: isScreenContext(screenContext) ? screenContext : null,
  };
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || null;
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

  const model = resolveChatModel();
  if (model === null) {
    return jsonError("assistant_unavailable", 503);
  }

  const asOf =
    target.kind === "demo"
      ? target.now.slice(0, 10)
      : new Date().toISOString().slice(0, 10);

  const result = streamText({
    model,
    system: buildChatSystemPrompt(body.screenContext),
    messages: await convertToModelMessages(body.messages),
    tools: createChatTools({
      runWithStore: (run) =>
        withStore((store) => run({ agentView: store.agentView }), target),
      asOf,
    }),
    stopWhen: isStepCount(MAX_STEPS),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
    headers: NO_STORE,
  });
}

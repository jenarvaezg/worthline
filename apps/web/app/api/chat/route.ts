import {
  NO_TURN_ATTACHMENT,
  readTurnAttachment,
} from "@web/api/chat/chat-attachment-phase";
import { repairHistoryForModel } from "@web/api/chat/chat-history-phase";
import {
  eligibleProvidersFor,
  prepareTurnPerProvider,
  recordProviderRejection,
} from "@web/api/chat/chat-provider-phase";
import {
  chatRateLimitReached,
  meterTurnTokens,
  openTurnSpendDoors,
} from "@web/api/chat/chat-quota-gates";
import {
  clientIp,
  declaredBodyTooLarge,
  isMultipartRequest,
  readChatRequest,
} from "@web/api/chat/chat-request-body";
import {
  attachmentCardStream,
  jsonError,
  NO_STORE,
  paywallResponse,
  previewOnlyResponse,
} from "@web/api/chat/chat-responses";
import { buildTurnToolsFactory } from "@web/api/chat/chat-turn-context";
import { resolveChatModels } from "@web/asistente/chat-model";
import {
  classifyPreOutputProviderError,
  streamWithProviderFailover,
} from "@web/asistente/provider-failover";
import { isAssistantSurface } from "@web/asistente/screen-context";
import { buildChatSystemPrompt } from "@web/asistente/system-prompt";
import { MAX_STEPS, TOOL_PROMPT_BUDGET } from "@web/asistente/turn-prompt-budget";
import { readStoreTarget } from "@web/read-store-target";
import {
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai";

/**
 * The assistant's chat route (#629) — the spine of PRD #627. Streams model
 * output over the AI SDK, grounded by chat tools that see the agent-view read
 * store plus the narrow persisted-proposal store (ADR 0044/0059). Conversation
 * messages remain ephemeral; only typed proposal facts and document references
 * survive turns, never raw file contents. Rate limiting runs BEFORE any provider
 * call (ADR 0051).
 *
 * HOW TO READ IT since #1697: the handler below is the ORDER, and nothing else. Every
 * phase is a named function in a sibling module — `chat-request-body.ts`,
 * `chat-quota-gates.ts`, `chat-attachment-phase.ts`, `chat-history-phase.ts`,
 * `chat-turn-context.ts`, `chat-provider-phase.ts`, `chat-responses.ts` — and each of
 * those carries the reasoning for what it does. What is left here is the sequence,
 * which is itself load-bearing: the doors that cost the caller money run before the
 * ones that cost worthline money, the multipart body is not parsed until the rate limit
 * has spoken, and every exit that has already paid for an extraction shows its card.
 */
export async function POST(request: Request): Promise<Response> {
  if (declaredBodyTooLarge(request)) {
    return jsonError("attachment_too_large", 413);
  }

  // An ordinary JSON turn is parsed eagerly; a multipart one waits until the rate
  // limit has spoken, because `request.formData()` materializes the whole body.
  const multipart = isMultipartRequest(request);
  let input = multipart ? null : await readChatRequest(request);
  if (!multipart && !input) {
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

  const ip = clientIp(request);
  if (await chatRateLimitReached({ ip, nowIso: new Date().toISOString(), target })) {
    return jsonError("rate_limited", 429);
  }

  input ??= await readChatRequest(request);
  if (!input) {
    return jsonError("invalid_body", 400);
  }
  const { attachment, body } = input;

  if (body.screenContext && !isAssistantSurface(body.screenContext.route)) {
    return jsonError("invalid_surface", 403);
  }

  const nowIso = new Date().toISOString();
  const spend = await openTurnSpendDoors({ attachment, ip, nowIso, target });
  if (spend.kind === "paywall") {
    return paywallResponse(spend.message);
  }
  if (spend.kind === "refused") {
    return jsonError(spend.error, spend.status);
  }

  const { preview, unstructured } = attachment
    ? await readTurnAttachment({
        attachment,
        nowIso,
        target,
        visionMeter: spend.visionMeter,
      })
    : NO_TURN_ATTACHMENT;

  const eligibleProviders = await eligibleProvidersFor(providers);
  if (eligibleProviders.length === 0) {
    return preview
      ? previewOnlyResponse(preview, unstructured)
      : jsonError("assistant_unavailable", 503);
  }

  const prepared = await prepareTurnPerProvider({
    buildTools: buildTurnToolsFactory({
      ingestionAllowed: spend.ingestionAllowed,
      messages: body.messages,
      preview,
      target,
      unstructured,
    }),
    messages: repairHistoryForModel(body.messages, TOOL_PROMPT_BUDGET),
    preview,
    providers: eligibleProviders,
    unstructured,
  });
  if (prepared.size === 0) {
    return preview
      ? previewOnlyResponse(preview, unstructured)
      : jsonError("invalid_body", 400);
  }

  const system = buildChatSystemPrompt(body.screenContext);
  const selected = await streamWithProviderFailover({
    providers: eligibleProviders.filter((provider) => prepared.has(provider.provider)),
    startStream: (provider) => {
      const turn = prepared.get(provider.provider)!;
      return streamText({
        model: provider.model,
        system,
        messages: turn.messages,
        tools: turn.tools,
        stopWhen: isStepCount(MAX_STEPS),
        // Cross-provider failover is the retry policy for a rejected request.
        // Retrying the same 429 first would delay request-too-large failover.
        maxRetries: 0,
        // AI SDK's default callback logs the complete APICallError, including
        // requestBodyValues. Attempt and stream logs below are sanitized.
        onError: () => undefined,
      }).stream;
    },
    log: (entry) => console.info("Assistant provider attempt", entry),
    onRejected: recordProviderRejection,
  });
  if (selected === null) {
    return preview
      ? previewOnlyResponse(preview, unstructured)
      : jsonError("assistant_unavailable", 503);
  }

  const workspaceId = target.kind === "authenticated" ? target.workspaceId : null;
  const providerStream = toUIMessageStream({
    stream: meterTurnTokens(selected.stream, workspaceId, nowIso),
    onError: (error) => {
      console.error("Chat stream failed", {
        provider: selected.provider.provider,
        modelId: selected.provider.modelId,
        classification: classifyPreOutputProviderError(error) ?? "provider_error",
      });
      return "provider_error";
    },
  });

  return createUIMessageStreamResponse({
    stream: preview ? attachmentCardStream(preview, providerStream) : providerStream,
    headers: NO_STORE,
  });
}

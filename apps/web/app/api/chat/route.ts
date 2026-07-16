import {
  type AttachmentPreviewData,
  parseAttachmentPreviewData,
  prepareAttachmentMessagesForModel,
} from "@web/asistente/attachment-chat";
import { extractPositionsFromImage } from "@web/asistente/attachment-image-extractor";
import { extractBalanceSeriesFromPdf } from "@web/asistente/attachment-pdf-extractor";
import { extractPositionsFromSpreadsheet } from "@web/asistente/attachment-spreadsheet-extractor";
import { chatAsOf } from "@web/asistente/chat-clock";
import { resolveChatModels } from "@web/asistente/chat-model";
import { createChatTools } from "@web/asistente/chat-tools";
import { raiseMaintainerAlert } from "@web/asistente/maintainer-alert-store";
import {
  deriveProviderCooldownUntil,
  providersOutsideCooldown,
} from "@web/asistente/provider-cooldown";
import {
  readProviderCooldowns,
  recordProviderCooldown,
} from "@web/asistente/provider-cooldown-store";
import {
  classifyPreOutputProviderError,
  streamWithProviderFailover,
} from "@web/asistente/provider-failover";
import { chatRatePlan, chatRateWindow } from "@web/asistente/rate-limit";
import { countChatRequest } from "@web/asistente/rate-limit-store";
import {
  isAssistantSurface,
  isScreenContext,
  type ScreenContext,
} from "@web/asistente/screen-context";
import { buildChatSystemPrompt } from "@web/asistente/system-prompt";
import { readStoreTarget } from "@web/read-store-target";
import { withStore } from "@web/store";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { NextResponse } from "next/server";

/**
 * The assistant's chat route (#629) — the spine of PRD #627. Streams model
 * output over the AI SDK, grounded by chat tools that see the agent-view read
 * store plus the narrow persisted-proposal store (ADR 0044/0059). Conversation
 * messages remain ephemeral; only typed proposal facts and document references
 * survive turns, never raw file contents. Rate limiting runs BEFORE any provider
 * call (ADR 0051).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_MESSAGES = 40;
const MAX_TOTAL_CHARS = 16_000;
const MAX_ATTACHMENT_HISTORY_CHARS = 256_000;
/** Read tool + suggest_actions (#631) + answer, with one step of headroom. */
const MAX_STEPS = 4;

interface ChatBody {
  messages: UIMessage[];
  screenContext: ScreenContext | null;
}

interface ChatRequestInput {
  attachment: File | null;
  body: ChatBody;
}

function messagesSizeForLimit(messages: unknown[]): {
  attachmentChars: number;
  ordinaryChars: number;
} {
  let attachmentChars = 0;
  const counted = messages.map((message) => {
    if (message === null || typeof message !== "object") return message;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return message;
    return {
      ...message,
      parts: parts.filter((part) => {
        if (
          part === null ||
          typeof part !== "object" ||
          (part as { type?: unknown }).type !== "data-attachment-extraction"
        ) {
          return true;
        }
        const preview = parseAttachmentPreviewData((part as { data?: unknown }).data);
        if (preview === null) return true;
        attachmentChars += JSON.stringify(preview).length;
        return false;
      }),
    };
  });
  return { attachmentChars, ordinaryChars: JSON.stringify(counted).length };
}

function parseChatBody(raw: unknown): ChatBody | null {
  if (raw === null || typeof raw !== "object") return null;

  const { messages, screenContext } = raw as {
    messages?: unknown;
    screenContext?: unknown;
  };
  if (!Array.isArray(messages) || messages.length === 0) return null;
  if (messages.length > MAX_MESSAGES) return null;
  const messageSizes = messagesSizeForLimit(messages);
  if (
    messageSizes.ordinaryChars > MAX_TOTAL_CHARS ||
    messageSizes.attachmentChars > MAX_ATTACHMENT_HISTORY_CHARS
  ) {
    return null;
  }
  const shapedLikeUIMessages = messages.every(
    (m) =>
      m !== null &&
      typeof m === "object" &&
      Array.isArray((m as { parts?: unknown }).parts),
  );
  if (!shapedLikeUIMessages) return null;
  if (
    messages.some((message) =>
      (message as { parts: Array<{ type?: unknown }> }).parts.some(
        (part) => part?.type === "file",
      ),
    )
  ) {
    return null;
  }

  return {
    messages: messages as UIMessage[],
    screenContext: isScreenContext(screenContext) ? screenContext : null,
  };
}

async function readChatRequest(request: Request): Promise<ChatRequestInput | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    try {
      const body = parseChatBody(await request.json());
      return body ? { attachment: null, body } : null;
    } catch {
      return null;
    }
  }

  try {
    const form = await request.formData();
    const messages = form.get("messages");
    const screenContext = form.get("screenContext");
    const attachments = form.getAll("attachment");
    if (
      typeof messages !== "string" ||
      typeof screenContext !== "string" ||
      attachments.length !== 1 ||
      !(attachments[0] instanceof File)
    ) {
      return null;
    }
    const body = parseChatBody({
      messages: JSON.parse(messages),
      screenContext: JSON.parse(screenContext),
    });
    return body ? { attachment: attachments[0], body } : null;
  } catch {
    return null;
  }
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

function operationalCause(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}

export async function POST(request: Request): Promise<Response> {
  const isMultipart =
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("multipart/form-data") ?? false;
  let input = isMultipart ? null : await readChatRequest(request);
  if (!isMultipart && !input) {
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

  input ??= await readChatRequest(request);
  if (!input) {
    return jsonError("invalid_body", 400);
  }
  const { attachment, body } = input;

  if (body.screenContext && !isAssistantSurface(body.screenContext.route)) {
    return jsonError("invalid_surface", 403);
  }

  let currentPreview: AttachmentPreviewData | null = null;
  if (attachment) {
    const fileName = attachment.name.trim();
    const mimeType = attachment.type.toLowerCase();
    const extractionInput = {
      bytes: new Uint8Array(await attachment.arrayBuffer()),
      fileName,
      mimeType: attachment.type,
    };
    const isPdf =
      mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
    currentPreview = {
      fileName,
      result: isPdf
        ? await extractBalanceSeriesFromPdf(extractionInput)
        : mimeType.startsWith("image/")
          ? await extractPositionsFromImage(extractionInput)
          : extractPositionsFromSpreadsheet(extractionInput),
    };
    if (currentPreview.result.status !== "valid") {
      const preview = currentPreview;
      const failureMessage = currentPreview.result.message;
      const textId = "attachment-extraction-message";
      return createUIMessageStreamResponse({
        headers: NO_STORE,
        stream: createUIMessageStream({
          execute: ({ writer }) => {
            writer.write({ type: "data-attachment-extraction", data: preview });
            writer.write({ type: "text-start", id: textId });
            writer.write({
              type: "text-delta",
              id: textId,
              delta: failureMessage,
            });
            writer.write({ type: "text-end", id: textId });
          },
        }),
      });
    }
  }

  let eligibleProviders = providers;
  try {
    const cooldownState = await readProviderCooldowns();
    eligibleProviders =
      cooldownState.mode === "local"
        ? providers.slice(0, 1)
        : providersOutsideCooldown(providers, cooldownState.cooldowns);
  } catch (error) {
    console.error("Assistant provider cooldown read failed", {
      operation: "read",
      cause: operationalCause(error),
    });
  }
  if (eligibleProviders.length === 0) {
    return jsonError("assistant_unavailable", 503);
  }

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(
      prepareAttachmentMessagesForModel(body.messages, currentPreview),
    );
  } catch {
    return jsonError("invalid_body", 400);
  }

  const system = buildChatSystemPrompt(body.screenContext);
  // Maintainer alerts persist only for a real workspace (ADR 0064). Demo is
  // read-only and local dev has no control plane, so the closure is bound only
  // when authenticated; otherwise the tool reports the alert as unavailable.
  const workspaceId = target.kind === "authenticated" ? target.workspaceId : null;
  const tools = createChatTools({
    runWithStore: (run) =>
      withStore(
        (store) =>
          run({
            agentView: store.agentView,
            assets: store.assets,
            assistantProposals: store.assistantProposals,
            liabilities: store.liabilities,
          }),
        target,
      ),
    asOf: chatAsOf(target),
    ...(workspaceId === null
      ? {}
      : {
          raiseMaintainerAlert: (alert) =>
            raiseMaintainerAlert({ workspaceId, ...alert }),
        }),
  });
  const selected = await streamWithProviderFailover({
    providers: eligibleProviders,
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
    onRejected: async ({ provider, classification, error }) => {
      const cooldownUntil = deriveProviderCooldownUntil(error, classification);
      if (cooldownUntil === null) return;
      try {
        const persisted = await recordProviderCooldown(provider.provider, cooldownUntil);
        if (persisted) {
          console.info("Assistant provider cooldown recorded", {
            provider: provider.provider,
            modelId: provider.modelId,
            classification,
            cooldownUntil: cooldownUntil.toISOString(),
          });
        }
      } catch (storageError) {
        console.error("Assistant provider cooldown write failed", {
          operation: "write",
          provider: provider.provider,
          classification,
          cause: operationalCause(storageError),
        });
      }
    },
  });
  if (selected === null) {
    return jsonError("assistant_unavailable", 503);
  }

  const providerStream = toUIMessageStream({
    stream: selected.stream,
    onError: (error) => {
      console.error("Chat stream failed", {
        provider: selected.provider.provider,
        modelId: selected.provider.modelId,
        classification: classifyPreOutputProviderError(error) ?? "provider_error",
      });
      return "provider_error";
    },
  });
  const stream = currentPreview
    ? createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({
            type: "data-attachment-extraction",
            data: currentPreview,
          });
          writer.merge(providerStream);
        },
      })
    : providerStream;

  return createUIMessageStreamResponse({
    stream,
    headers: NO_STORE,
  });
}

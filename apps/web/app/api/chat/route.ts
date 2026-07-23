import {
  type AttachmentPreviewData,
  parseAttachmentPreviewData,
  prepareAttachmentMessagesForModel,
  type UnstructuredAttachment,
} from "@web/asistente/attachment-chat";
import { extractPositionsFromImage } from "@web/asistente/attachment-image-extractor";
import { extractBalanceSeriesFromPdf } from "@web/asistente/attachment-pdf-extractor";
import { extractSpreadsheetDocument } from "@web/asistente/attachment-spreadsheet-dispatch";
import {
  renderSpreadsheetForContext,
  UNSTRUCTURED_SPREADSHEET_MESSAGE,
} from "@web/asistente/attachment-spreadsheet-extractor";
import { chatAsOf } from "@web/asistente/chat-clock";
import { resolveChatModels } from "@web/asistente/chat-model";
import { createChatTools } from "@web/asistente/chat-tools";
import {
  courtesyMonthWindow,
  isCourtesyQuotaExhausted,
} from "@web/asistente/courtesy-quota";
import { countAssistantCourtesyUse } from "@web/asistente/courtesy-quota-store";
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
import {
  isGlobalTokenFuseBlown,
  isWorkspaceTokenBudgetExhausted,
  tokenDayWindow,
} from "@web/asistente/token-budget";
import { readAiTokenUsage, recordAiTokenUsage } from "@web/asistente/token-budget-store";
import { meterAssistantStream } from "@web/asistente/token-metering";
import { isPremiumIngestionAllowed } from "@web/entitlements/effective-plan";
import {
  PAYWALL_ATTACHMENT_MESSAGE,
  PAYWALL_COURTESY_MESSAGE,
  PAYWALL_GLOBAL_FUSE_MESSAGE,
  PAYWALL_TOKEN_BUDGET_MESSAGE,
} from "@web/entitlements/paywall-copy";
import { readEffectivePlan } from "@web/entitlements/read-effective-plan";
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
import { after, NextResponse } from "next/server";

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
/** Read tool(s) + answer + suggest_actions (#631), with headroom for one extra read. */
const MAX_STEPS = 6;

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

/**
 * Stream the honest paywall (#1162) instead of an error: a `data-paywall` part
 * the assistant panel renders as a premium reminder. A 200 stream, not a 4xx,
 * so it reads as a normal assistant turn — never a scary failure, never a wall
 * in front of the user's own data.
 */
function paywallResponse(message: string): Response {
  return createUIMessageStreamResponse({
    headers: NO_STORE,
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "data-paywall", data: { message } });
      },
    }),
  });
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

  // Premium ingestion gate + free courtesy quota (PRD #1160 S2, #1162). The plan
  // is derived server-side from the control plane (S1); demo/local bypass to
  // premium. Reads and manual tracking never pass through here — only the
  // machine reading documents for you, and the free monthly courtesy turns.
  const nowIso = new Date().toISOString();
  const effectivePlan = await readEffectivePlan(target, nowIso);
  const ingestionAllowed = isPremiumIngestionAllowed(effectivePlan);

  // A free workspace cannot have the machine read a document for it — but every
  // figure it typed stays free. Honest reminder, no courtesy turn charged.
  if (attachment && !ingestionAllowed) {
    return paywallResponse(PAYWALL_ATTACHMENT_MESSAGE);
  }

  // AI token metering + shared daily fuse (PRD #1160 S3, #1163). Counted per UTC
  // day in the control plane and checked BEFORE the model call — so the eager
  // extractor degrades honestly too, running only after this gate. The fuse
  // applies to every authenticated caller; the per-plan workspace budget bites
  // only trial/premium (free is bounded by the courtesy quota below, not tokens).
  // A null read is unmetered (local dev) — the pure predicates never fire.
  //
  // demo/local deliberately bypass the meter, exactly as S2's courtesy quota and
  // ingestion gates do: demo is already coarsely IP-rate-limited (ADR 0051) and
  // its shared spend is capped by the Gateway money ceiling (ADR 0050); local
  // dev owns its own key. The token fuse governs the authenticated shared spend
  // the trial opens up — the abuse surface it was designed for (plan §4.2).
  if (target.kind === "authenticated") {
    const usage = await readAiTokenUsage(target.workspaceId, tokenDayWindow(nowIso));
    if (usage && isGlobalTokenFuseBlown(usage.globalTokens)) {
      return paywallResponse(PAYWALL_GLOBAL_FUSE_MESSAGE);
    }
    if (usage && isWorkspaceTokenBudgetExhausted(usage.workspaceTokens, effectivePlan)) {
      return paywallResponse(PAYWALL_TOKEN_BUDGET_MESSAGE);
    }
  }

  // The free plan's monthly courtesy quota over the shared assistant (ADR 0051
  // mechanism). Only authenticated free turns that reach the model count;
  // trial/premium answer to the token budget (S3), demo/local bypass entirely.
  if (target.kind === "authenticated" && effectivePlan === "free") {
    const used = await countAssistantCourtesyUse(
      `ws:${target.workspaceId}`,
      courtesyMonthWindow(nowIso),
    );
    if (isCourtesyQuotaExhausted(used)) {
      return paywallResponse(PAYWALL_COURTESY_MESSAGE);
    }
  }

  let currentPreview: AttachmentPreviewData | null = null;
  let unstructuredAttachment: UnstructuredAttachment | null = null;
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
    const isImage = mimeType.startsWith("image/");
    const isSpreadsheet = !isPdf && !isImage;
    const result = isPdf
      ? await extractBalanceSeriesFromPdf(extractionInput)
      : isImage
        ? await extractPositionsFromImage(extractionInput)
        : extractSpreadsheetDocument(extractionInput);
    currentPreview = { fileName, result };

    if (result.status !== "valid") {
      // A readable spreadsheet that is not a positions table becomes
      // conversational material instead of a dead-end (#865): render the whole
      // book and let the model describe it — never as validated figures.
      if (isSpreadsheet && result.status === "unrecognized") {
        const text = renderSpreadsheetForContext(extractionInput);
        if (text) {
          unstructuredAttachment = { fileName, text };
          currentPreview = {
            fileName,
            result: { message: UNSTRUCTURED_SPREADSHEET_MESSAGE, status: "unrecognized" },
          };
        }
      }
      if (!unstructuredAttachment) {
        // An honest dead-end (unreadable, too large): the preview card carries
        // the message, so no redundant text bubble repeats it.
        const preview = currentPreview;
        return createUIMessageStreamResponse({
          headers: NO_STORE,
          stream: createUIMessageStream({
            execute: ({ writer }) => {
              writer.write({ type: "data-attachment-extraction", data: preview });
            },
          }),
        });
      }
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
      prepareAttachmentMessagesForModel(
        body.messages,
        currentPreview,
        unstructuredAttachment,
      ),
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
    ingestionAllowed,
    runWithStore: (run) =>
      withStore(
        (store) =>
          run({
            agentView: store.agentView,
            assets: store.assets,
            assistantProposals: store.assistantProposals,
            connectedSources: store.connectedSources,
            liabilities: store.liabilities,
            workspace: store.workspace,
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

  // Record this turn's tokens once it finishes (PRD #1160 S3, #1163). The count
  // is only known at the finish part — after we have begun streaming — so we tap
  // the stream and schedule the write with `after()`, never blocking the reply.
  // Gated on a real control plane so local dev and the route tests stay unmetered.
  let meteredStream = selected.stream;
  if (workspaceId !== null && process.env["WORTHLINE_CONTROL_PLANE_DB_URL"]) {
    const metered = meterAssistantStream(selected.stream);
    meteredStream = metered.stream;
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
  }

  const providerStream = toUIMessageStream({
    stream: meteredStream,
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

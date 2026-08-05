import {
  type AttachmentPreviewData,
  hasUnstructuredEvidenceInHistory,
  isValidatedDocument,
  parseAttachmentPreviewData,
  prepareAttachmentMessagesForModel,
  type UnstructuredAttachment,
  validatedDocumentsForTools,
} from "@web/asistente/attachment-chat";
import { ATTACHMENT_EXTRACTION_LIMITS_V1 } from "@web/asistente/attachment-extraction-contract";
import { isVisionAttachment, readAttachmentTurn } from "@web/asistente/attachment-turn";
import {
  EMPTY_READING_MESSAGE,
  UNIDENTIFIED_DOCUMENT_MESSAGE,
} from "@web/asistente/attachment-types";
import { chatAsOf } from "@web/asistente/chat-clock";
import {
  correctFabricatedProposalClaims,
  dropStaleToolPayloads,
  pruneOrphanToolCalls,
  withoutToolParts,
} from "@web/asistente/chat-history";
import { resolveChatModels } from "@web/asistente/chat-model";
import { chatToolStores, createChatTools } from "@web/asistente/chat-tools";
import {
  courtesyMonthWindow,
  isCourtesyQuotaExhausted,
} from "@web/asistente/courtesy-quota";
import { countAssistantCourtesyUse } from "@web/asistente/courtesy-quota-store";
import { groundedHoldingIdsInHistory } from "@web/asistente/holding-id-provenance";
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
import {
  chatRatePlan,
  chatRateWindow,
  demoGlobalRatePlan,
} from "@web/asistente/rate-limit";
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
import { unvalidatedEvidenceGateApplies } from "@web/asistente/unvalidated-evidence-gate";
import {
  isGlobalVisionCallFuseBlown,
  isVisionCallBudgetExhausted,
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
  type UIMessageChunk,
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

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_MESSAGES = 40;
const MAX_TOTAL_CHARS = 16_000;
const MAX_ATTACHMENT_HISTORY_CHARS = 256_000;
/**
 * Tool payloads in history are NOT charged to {@link MAX_TOTAL_CHARS} (#1260).
 * They are not the user's text and they dwarf it: ONE `get_snapshot_history` with
 * per-position rows measures 113 773 characters — seven times that ceiling — so
 * charging it there killed a healthy conversation with a permanent 400, and the
 * client re-sends the same history every turn, so there was no way back.
 *
 * There is deliberately NO size ceiling that refuses them either: a refusal is
 * permanent for the same reason. Oversized history is SHRUNK instead, below.
 */
const MAX_TOOL_PROMPT_CHARS = 80_000;
/**
 * Room for the freshest reading AND a pending proposal at the same time: measured,
 * `get_snapshot_history` with summary rows is 42 550 characters, so a tighter total
 * meant one of the two had to go — the reading the answer stands on, or the
 * proposal the user is about to confirm.
 */
const MAX_TOOL_PROPOSAL_CHARS = 48_000;
/** What the readings behind the freshest one share before being dropped. */
const MAX_STALE_TOOL_READ_CHARS = 24_000;
/**
 * And how many tool parts may survive at all, because characters alone do not
 * bound the prompt: the SDK expands each kept part into a call AND a result, so
 * 10 000 tiny parts fitted the character budget and still tripled it. Six steps
 * per turn ({@link MAX_STEPS}) means this covers several turns of grounding.
 */
const MAX_TOOL_PARTS_IN_PROMPT = 40;
/** Read tool(s) + answer + suggest_actions (#631), with headroom for one extra read. */
const MAX_STEPS = 6;
/**
 * Ceiling on the whole request body (#1180): the 4 MiB attachment cap plus room
 * for the text conversation that rides along in the same multipart body
 * ({@link MAX_TOTAL_CHARS} + {@link MAX_ATTACHMENT_HISTORY_CHARS}) and the
 * multipart framing. A legitimate request can never approach it; a hostile one
 * is refused before a byte is parsed.
 *
 * Tool payloads ride along without a ceiling of their own (#1260), so this is the
 * one door a very long conversation can still reach — and it CAN: 40 turns of the
 * largest reading measured (113 773 chars) plus the other two budgets exceed it
 * (4 822 920 > 4 718 592), and a single turn can carry up to {@link MAX_STEPS}
 * readings, so ~9 multi-read turns suffice. Deliberately not widened: this is the
 * #1180 door against a hostile body. What is fixed instead is the copy of its 413,
 * which no longer blames a file that a JSON turn does not even carry.
 */
const MAX_REQUEST_BYTES = ATTACHMENT_EXTRACTION_LIMITS_V1.maxBytes + 512 * 1024;

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
  return {
    attachmentChars,
    ordinaryChars: JSON.stringify(withoutToolParts(counted)).length,
  };
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

/**
 * The ONE place that writes the extraction preview card into a stream. Every exit
 * that has already paid for an extraction must show its verdict — with the model
 * turn merged in when there is one, alone when the model is unreachable (#1242).
 */
function attachmentCardStream(
  preview: AttachmentPreviewData,
  providerStream: ReadableStream<UIMessageChunk> | null,
): ReadableStream<UIMessageChunk> {
  return createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "data-attachment-extraction", data: preview });
      if (providerStream) writer.merge(providerStream);
    },
  });
}

/**
 * The card to show when there will be NO model turn under it.
 *
 * The unstructured lanes replace the verdict with a card that promises the
 * conversation continues — «te comento lo que veo del archivo aquí debajo» (#865),
 * «te cuento lo que veo aquí debajo» (#1246). That promise is only true when the
 * model answers. On a model-unreachable exit the user would read it with nothing
 * underneath, and on the #1246 lane they would have paid for TWO vision calls to
 * get it. So the honest dead-end message takes its place: nothing was extracted,
 * and this time nothing describes it either.
 */
function previewWithoutModelTurn(
  preview: AttachmentPreviewData,
  unstructured: UnstructuredAttachment | null,
): AttachmentPreviewData {
  if (!unstructured) return preview;
  // Which dead end, though: an `empty_reading` capture is described too now (#1246), and
  // telling that user «no reconozco ninguno de los documentos que sé leer» would deny a
  // document the seam DID identify. The verdict is preserved and only the promise of a
  // conversation is withdrawn.
  const emptyReading =
    preview.result.status === "unrecognized" && preview.result.reason === "empty_reading";
  return {
    fileName: preview.fileName,
    result: emptyReading
      ? {
          message: EMPTY_READING_MESSAGE,
          reason: "empty_reading",
          status: "unrecognized",
        }
      : {
          message: UNIDENTIFIED_DOCUMENT_MESSAGE,
          reason: "unidentified_document",
          status: "unrecognized",
        },
  };
}

/**
 * The model is unreachable, but the extraction verdict was already paid for and
 * the user must read it (#1130): a 200 stream carrying just the card, never a
 * bare 4xx/5xx that the transport turns into a generic Error.
 */
function previewOnlyResponse(
  preview: AttachmentPreviewData,
  unstructured: UnstructuredAttachment | null,
): Response {
  return createUIMessageStreamResponse({
    headers: NO_STORE,
    stream: attachmentCardStream(previewWithoutModelTurn(preview, unstructured), null),
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

  // First bound, on the DECLARED body size, before anything is parsed (#1180).
  // `request.formData()` materializes the whole multipart body, so checking only
  // the attachment afterwards would still have paid for the first copy. Absent or
  // unparseable `Content-Length` (a chunked body) falls through to the
  // per-attachment cap below — this is a cheap door, not the only one.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return jsonError("attachment_too_large", 413);
  }

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

  const ip = clientIp(request);
  const plan = chatRatePlan(target, ip);
  const rateWindow = chatRateWindow(new Date().toISOString());
  if (plan.mode === "count") {
    const count = await countChatRequest(plan.key, rateWindow);
    if (count !== null && count > plan.limit) {
      return jsonError("rate_limited", 429);
    }
  }
  if (target.kind === "demo") {
    const globalPlan = demoGlobalRatePlan();
    const globalCount = await countChatRequest(globalPlan.key, rateWindow);
    if (globalCount !== null && globalCount > globalPlan.limit) {
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
  // ingestion gates do: demo is IP-rate-limited plus a shared hourly global budget
  // (#1184, ADR 0051); its provider spend is also backstopped by the Gateway money
  // ceiling (ADR 0050); local dev owns its own key. The token fuse governs the
  // authenticated shared spend the trial opens up — the abuse surface it was
  // designed for (plan §4.2).
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

  // Reject an oversized upload on its DECLARED size, before `arrayBuffer()`
  // materializes the whole body in the JS heap (#1180). The contract's `maxBytes`
  // cap (`checkAttachmentLimits`) also catches this, but only *after* buffering —
  // so a caller could push arbitrarily large bodies through memory just to be
  // told they were too large. Cheap DoS closed at the door: same threshold, same
  // 4 MiB contract, checked one step earlier.
  if (attachment && attachment.size > ATTACHMENT_EXTRACTION_LIMITS_V1.maxBytes) {
    return jsonError("attachment_too_large", 413);
  }

  // The eager extractor's own money fuse (#1258). Every gate above is blind to it:
  // the vision seam calls a paid provider BEFORE the conversational turn, its
  // contract returns validated JSON and never provider usage (so the token meter
  // has nothing to read), and `demo` resolves to `premium`, so the ingestion
  // paywall does not fire for an anonymous visitor either. #1246 then doubled the
  // worst case — an unidentified attachment costs two vision calls, and the caller
  // chooses whether to pay by uploading something the seam cannot type.
  //
  // So: its OWN daily counter, in calls, checked here before a byte is read and
  // recorded after the reading. Nothing about `token-metering.ts` changes — that
  // one still means the conversational turn (#1163).
  const visionPlan = visionCallPlan(target, ip);
  const visionDayKey = visionCallDayWindow(nowIso);
  // Null when there is nothing to meter: no attachment, a spreadsheet (the
  // deterministic route never reaches a model, so braking one would refuse a free
  // upload with a message about a cost it does not have), or the local target where
  // the developer owns the key (ADR 0051). It carries the scope through to the
  // recording below, so the gate and the counter can never disagree on the key.
  const visionMeter =
    attachment &&
    isVisionAttachment({ fileName: attachment.name, mimeType: attachment.type }) &&
    visionPlan.mode === "count"
      ? visionPlan
      : null;
  if (visionMeter) {
    const usage = await readVisionCallUsage(visionMeter.scopeKey, visionDayKey);
    if (usage && isGlobalVisionCallFuseBlown(usage.globalCalls)) {
      return paywallResponse(PAYWALL_VISION_FUSE_MESSAGE);
    }
    if (usage && isVisionCallBudgetExhausted(usage.scopeCalls, visionMeter.dailyLimit)) {
      return paywallResponse(PAYWALL_VISION_BUDGET_MESSAGE);
    }
  }

  // What the document IS, and the lane it travels in, is one seam (#1254) — shared
  // with the assistant eval so a run grades this behaviour rather than a copy of it.
  // The route keeps what is about the CALLER: quota, paywall, rate limits, cooldowns.
  let currentPreview: AttachmentPreviewData | null = null;
  let unstructuredAttachment: UnstructuredAttachment | null = null;
  if (attachment) {
    const reading = await readAttachmentTurn({
      bytes: new Uint8Array(await attachment.arrayBuffer()),
      fileName: attachment.name,
      mimeType: attachment.type,
    });
    currentPreview = reading.preview;
    unstructuredAttachment = reading.unstructured;
    if (reading.visionCalls > 0) {
      // Visible even where nothing is metered (local dev, demo without a control
      // plane): «how much do we spend on extraction» had no answer at all before
      // this, and one line per reading is the cheapest half of one. Aggregate
      // only — a count and the kind of caller, never the file or the scope key.
      console.info("Assistant attachment vision calls", {
        targetKind: target.kind,
        visionCalls: reading.visionCalls,
      });
    }
    if (visionMeter && reading.visionCalls > 0) {
      const { scopeKey } = visionMeter;
      const calls = reading.visionCalls;
      // After the response, like the token meter: the reading is already paid for,
      // and the user must not wait on a control-plane write to see their card.
      after(async () => {
        try {
          await recordVisionCalls(scopeKey, visionDayKey, calls);
        } catch (error) {
          console.error("Assistant vision call metering write failed", {
            operation: "write",
            cause: operationalCause(error),
          });
        }
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
    if (currentPreview) {
      return previewOnlyResponse(currentPreview, unstructuredAttachment);
    }
    return jsonError("assistant_unavailable", 503);
  }

  // The history is repaired before it is converted (#1260). A tool call whose
  // result never arrived — the provider died mid-stream — makes the SDK refuse
  // the whole prompt, and since the browser re-sends that history every turn, the
  // conversation would be dead for good. Every repair is logged, never silent:
  // they count how often a provider dies mid-tool-call, how much stale grounding a
  // long conversation is dragging along, and how often the model claims a proposal
  // it never asked for — the last one is the frequency #1262 had no way to measure.
  //
  // The fabricated-claim correction runs FIRST, on the untouched history: the prune
  // below removes an interrupted `propose_*` call, and a turn like that DID ask for
  // a real proposal.
  const corrected = correctFabricatedProposalClaims(body.messages);
  if (corrected.correctedMessageIds.length > 0) {
    // The ids, not just a count: the browser re-sends the whole history every turn,
    // so one incident appears again in every later request. Counting DISTINCT ids is
    // the only way to read a frequency out of this — a bare tally would grow with
    // the length of the thread and hand #1254 an inflated number.
    console.info("Assistant claimed a proposal it never prepared", {
      messageIds: corrected.correctedMessageIds,
      turnsInThisHistory: corrected.correctedMessageIds.length,
    });
  }
  const pruned = pruneOrphanToolCalls(corrected.messages);
  if (pruned.orphanToolCallIds.length > 0) {
    console.info("Assistant history orphan calls pruned", {
      orphanToolCalls: pruned.orphanToolCallIds.length,
    });
  }
  const shrunk = dropStaleToolPayloads(pruned.messages, {
    maxParts: MAX_TOOL_PARTS_IN_PROMPT,
    proposalChars: MAX_TOOL_PROPOSAL_CHARS,
    staleChars: MAX_STALE_TOOL_READ_CHARS,
    totalChars: MAX_TOOL_PROMPT_CHARS,
  });
  if (shrunk.droppedToolCallIds.length > 0) {
    console.info("Assistant history shrunk to fit", {
      droppedToolPayloads: shrunk.droppedToolCallIds.length,
    });
  }

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(
      prepareAttachmentMessagesForModel(
        shrunk.messages,
        currentPreview,
        unstructuredAttachment,
      ),
    );
  } catch {
    if (currentPreview) {
      return previewOnlyResponse(currentPreview, unstructuredAttachment);
    }
    return jsonError("invalid_body", 400);
  }

  const system = buildChatSystemPrompt(body.screenContext);
  // Maintainer alerts persist only for a real workspace (ADR 0064). Demo is
  // read-only and local dev has no control plane, so the closure is bound only
  // when authenticated; otherwise the tool reports the alert as unavailable.
  const workspaceId = target.kind === "authenticated" ? target.workspaceId : null;
  // The unvalidated-evidence boundary (#1248, PRD #1241): only this route knows
  // what the turn carries, so it derives the flag and the chat tools enforce it.
  // An unreadable attachment is deliberately NOT evidence — the model then holds
  // no document at all, so the source is the user's own text (the manual path).
  // The history trace closes the two-turn bypass; the exemption is this turn's
  // own extraction, never a client-supplied preview (see the gate module).
  const hasUnvalidatedEvidence =
    unstructuredAttachment !== null || hasUnstructuredEvidenceInHistory(body.messages);
  const unvalidatedEvidence = unvalidatedEvidenceGateApplies({
    hasUnvalidatedEvidence,
    hasValidatedDocumentInThisTurn: isValidatedDocument(currentPreview),
  });
  const tools = createChatTools({
    ingestionAllowed,
    unvalidatedEvidence,
    // The premise, not the verdict: the provenance mark on the card (#1257) marks
    // the turn the proposal was born in, and a validated document lifts the gate
    // without taking the unreadable file out of the model's context.
    hasUnvalidatedEvidence,
    // The documents the model was actually handed (#1373). The reconcile lane takes
    // its rows from them instead of from what the model typed, so a row that no
    // extraction contains cannot become a write. Read from `shrunk.messages` for the
    // same reason as the grounded ids: what grounds a write is what the model sees.
    validatedDocuments: validatedDocumentsForTools(shrunk.messages, currentPreview),
    // Holding-id provenance (#1263): the ids worthline itself put in the history the
    // model is about to read. Taken from `shrunk.messages`, so what grounds a write
    // is exactly what the model can see — a tool payload dropped by the ceiling
    // (#1260) is no longer in its context either, and it has to read again.
    groundedHoldingIds: groundedHoldingIdsInHistory(shrunk.messages),
    // One line per refused call, with the offending strings: this is the frequency
    // of the invention, and it is invisible otherwise — the turn simply carries on
    // without the proposal. Unlike the history repairs above it cannot inflate with
    // the length of the thread: a tool call happens once, in this turn.
    onUngroundedHoldingId: (rejection) =>
      console.info("Assistant pointed a write at an id it never read", rejection),
    // The maintainer alert is the only forensic channel there is (ADR 0064), so a
    // gate that can drop one must say when it did: an over-blocking guard is
    // otherwise invisible by construction (#1347).
    onMaintainerAlertRefused: (rejection) =>
      console.info("Assistant raised a maintainer alert with no discrepancy", rejection),
    runWithStore: (run) => withStore((store) => run(chatToolStores(store)), target),
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
    if (currentPreview) {
      return previewOnlyResponse(currentPreview, unstructuredAttachment);
    }
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
    ? attachmentCardStream(currentPreview, providerStream)
    : providerStream;

  return createUIMessageStreamResponse({
    stream,
    headers: NO_STORE,
  });
}

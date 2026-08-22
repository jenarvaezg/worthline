import {
  type AttachmentPreviewData,
  hasUnstructuredEvidenceInHistory,
  isValidatedDocument,
  prepareAttachmentMessagesForModel,
  validatedAttachmentsForTools,
  validatedDocumentsForTools,
} from "@web/asistente/attachment-chat";
import { ATTACHMENT_EXTRACTION_LIMITS_V1 } from "@web/asistente/attachment-extraction-contract";
import {
  isVisionAttachment,
  readAttachmentTurn,
  type UnstructuredReading,
} from "@web/asistente/attachment-turn";
import {
  EMPTY_READING_MESSAGE,
  UNIDENTIFIED_DOCUMENT_MESSAGE,
} from "@web/asistente/attachment-types";
import { chatAsOf } from "@web/asistente/chat-clock";
import {
  correctFabricatedProposalClaims,
  dropStaleToolPayloads,
  pruneOrphanToolCalls,
} from "@web/asistente/chat-history";
import { resolveChatModels } from "@web/asistente/chat-model";
import { chatToolStores, createChatTools } from "@web/asistente/chat-tools";
import {
  courtesyMonthWindow,
  isCourtesyQuotaExhausted,
} from "@web/asistente/courtesy-quota";
import { countAssistantCourtesyUse } from "@web/asistente/courtesy-quota-store";
import { fitHistoryToBudget } from "@web/asistente/history-prose-budget";
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
import {
  MAX_STEPS,
  TOOL_PROMPT_BUDGET,
  turnPromptBudget,
} from "@web/asistente/turn-prompt-budget";
import {
  NO_TYPED_BALANCE_SERIES,
  typedBalanceSeriesInTurn,
} from "@web/asistente/typed-balance-series";
import { typedTransferInTurn } from "@web/asistente/typed-transfer";
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
/**
 * Ceiling on the whole request body (#1180): the 4 MiB attachment cap plus room for
 * the conversation that rides along in the same multipart body and the multipart
 * framing. A legitimate request can never approach it; a hostile one is refused
 * before a byte is parsed.
 *
 * Since #1408 it is the ONLY size door in this route that refuses. Every budget the
 * prompt has — prose, attachment cards, tool payloads, message count — is fitted
 * per model in `turn-prompt-budget.ts` and shrunk to in `history-prose-budget.ts`,
 * because the browser re-sends the same history every turn: a refusal there was
 * permanent, and «recarga la página» was the only way out of a conversation the
 * route would not accept. This one stays a refusal on purpose — it guards against a
 * hostile body, not against a long conversation, and it is decided on
 * `Content-Length` before anything is parsed.
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

/**
 * Shape only, never size (#1408). Every size question — how much prose, how many
 * messages, how many attachment cards — is answered per model when the turn is
 * built, by shrinking rather than refusing. What is left here is what no amount of
 * shrinking can repair: a body that is not a conversation.
 */
function parseChatBody(raw: unknown): ChatBody | null {
  if (raw === null || typeof raw !== "object") return null;

  const { messages, screenContext } = raw as {
    messages?: unknown;
    screenContext?: unknown;
  };
  if (!Array.isArray(messages) || messages.length === 0) return null;
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
  unstructured: UnstructuredReading | null,
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
  unstructured: UnstructuredReading | null,
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
  let unstructuredAttachment: UnstructuredReading | null = null;
  if (attachment) {
    const reading = await readAttachmentTurn({
      bytes: new Uint8Array(await attachment.arrayBuffer()),
      fileName: attachment.name,
      mimeType: attachment.type,
      // The SAME date the tools value at, not `nowIso` (#1424): a demo target runs on
      // a pinned clock, and a reading that called half a schedule «previsión» against
      // a different today than the curve it feeds would contradict its own card.
      today: chatAsOf(target),
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
  const shrunk = dropStaleToolPayloads(pruned.messages, TOOL_PROMPT_BUDGET);
  if (shrunk.droppedToolCallIds.length > 0) {
    console.info("Assistant history shrunk to fit", {
      droppedToolPayloads: shrunk.droppedToolCallIds.length,
    });
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
  // The user's own keyboard as a way out of that gate (#1418). Read from the RAW
  // history, not from the fitted one the model gets: what grounds these rows is what
  // the user wrote, and a per-provider truncation of his message must not change the
  // series worthline read off it.
  //
  // Only parsed when the gate actually bites. Not for the cost — one message is
  // nothing — but because that is the only turn where this series means anything: an
  // ordinary turn already builds from the model's rows, and a value that could not
  // change any outcome is a value nobody should have to reason about.
  const typedBalanceSeries = unvalidatedEvidence
    ? typedBalanceSeriesInTurn(body.messages)
    : NO_TYPED_BALANCE_SERIES;
  // The traspaso dictated this turn (#1482). Read on EVERY turn, unlike the series
  // above: this is not an escape from a gate, it is the only source the lane has — its
  // importe and date are not tool arguments at all. From the RAW history for the same
  // reason: what grounds the figures is what the person wrote, and a per-provider
  // truncation of their message must not change what worthline read in it.
  const typedTransfer = typedTransferInTurn(body.messages, chatAsOf(target));
  const buildTools = (history: UIMessage[]) =>
    createChatTools({
      ingestionAllowed,
      unvalidatedEvidence,
      // The premise, not the verdict: the provenance mark on the card (#1257) marks
      // the turn the proposal was born in, and a validated document lifts the gate
      // without taking the unreadable file out of the model's context.
      hasUnvalidatedEvidence,
      // The documents the model was actually handed (#1373). The reconcile lane takes
      // its rows from them instead of from what the model typed, so a row that no
      // extraction contains cannot become a write. Read from the FITTED history for
      // the same reason as the grounded ids: what grounds a write is what the model
      // sees, and since #1408 that differs per provider.
      validatedDocuments: validatedDocumentsForTools(history, currentPreview),
      // Same list, with file names, for get_extracted_document (#1492).
      validatedAttachments: validatedAttachmentsForTools(history, currentPreview),
      // The series the user typed this turn (#1418): it reopens the debt-history lanes
      // the gate closed, and it is what those lanes build from.
      typedBalanceSeries,
      // The traspaso the user dictated this turn (#1482): the ONE source of its importe
      // and its date, so `propose_transfer` never builds from the model's arguments.
      typedTransfer,
      // Holding-id provenance (#1263): the ids worthline itself put in the history the
      // model is about to read — a payload dropped by the tool ceiling (#1260) or a
      // turn dropped by the prose budget (#1408) is no longer in its context either,
      // so it has to read again.
      groundedHoldingIds: groundedHoldingIdsInHistory(history),
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
        console.info(
          "Assistant raised a maintainer alert with no discrepancy",
          rejection,
        ),
      runWithStore: (run) => withStore((store) => run(chatToolStores(store)), target),
      asOf: chatAsOf(target),
      ...(workspaceId === null
        ? {}
        : {
            raiseMaintainerAlert: (alert) =>
              raiseMaintainerAlert({ workspaceId, ...alert }),
          }),
    });

  // ONE prompt PER PROVIDER (#1408). The history is fitted to the budget of the model
  // that is about to read it, so `gemini-3.1-flash-lite` — 1 048 576 input tokens —
  // keeps a whole conversation where a 30 000-tokens-per-minute fallback gets a cut
  // one. Before this, both were held to a single 16 000-character ceiling that
  // REFUSED, and one recited document ended the conversation for good.
  //
  // The tools are rebuilt per provider too, and that is not incidental: the write
  // gates take their allowlists from the history the model can see (#1263, #1373),
  // so deriving them once from the unfitted history would let them name a document
  // that this provider was never handed.
  type PreparedTurn = {
    messages: Awaited<ReturnType<typeof convertToModelMessages>>;
    tools: ReturnType<typeof createChatTools>;
  };
  const prepared = new Map<string, PreparedTurn>();
  for (const provider of eligibleProviders) {
    const budget = turnPromptBudget(provider);
    const fitted = fitHistoryToBudget(shrunk.messages, budget);
    if (
      fitted.droppedMessageIds.length > 0 ||
      fitted.droppedAttachmentCards > 0 ||
      fitted.truncatedMessageIds.length > 0
    ) {
      // Silent to the user by design (#1408), never silent to us: this is how often a
      // real conversation outgrows a real model, and the refusal it replaces made that
      // frequency unmeasurable — every one of them ended in a reload.
      console.info("Assistant history fitted to the model budget", {
        provider: provider.provider,
        modelId: provider.modelId,
        droppedMessages: fitted.droppedMessageIds.length,
        droppedAttachmentCards: fitted.droppedAttachmentCards,
        truncatedMessages: fitted.truncatedMessageIds.length,
      });
    }
    try {
      prepared.set(provider.provider, {
        messages: await convertToModelMessages(
          prepareAttachmentMessagesForModel(
            fitted.messages,
            currentPreview,
            // The reading, not the already-fitted block: remaining budget after the
            // typed cards is computed inside, so a historical series and this turn's
            // notebook share one ceiling instead of stacking (#1492, #1419).
            unstructuredAttachment ?? null,
            budget.attachmentChars,
          ),
        ),
        tools: buildTools(fitted.messages),
      });
    } catch {
      // A history the SDK cannot convert is unconvertible for every provider, so
      // this leaves the map empty and takes the exit below.
    }
  }
  if (prepared.size === 0) {
    if (currentPreview) {
      return previewOnlyResponse(currentPreview, unstructuredAttachment);
    }
    return jsonError("invalid_body", 400);
  }

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

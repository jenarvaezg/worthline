/**
 * Reading the chat request: what came in, and whether it is a conversation at all
 * (#1697, extracted from `route.ts`).
 *
 * Kept apart from the route because none of it touches the model, the store or the
 * meters — it is the request and nothing else, and it is the one phase of the POST
 * that runs TWICE for a multipart body: the rate limit has to decide before
 * `request.formData()` materializes 4 MiB in the heap, so the parse is deferred until
 * after the quota doors (ADR 0051).
 */

import { ATTACHMENT_EXTRACTION_LIMITS_V1 } from "@web/asistente/attachment-extraction-contract";
import { isScreenContext, type ScreenContext } from "@web/asistente/screen-context";
import type { UIMessage } from "ai";

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
export const MAX_REQUEST_BYTES = ATTACHMENT_EXTRACTION_LIMITS_V1.maxBytes + 512 * 1024;

export interface ChatBody {
  messages: UIMessage[];
  screenContext: ScreenContext | null;
}

export interface ChatRequestInput {
  attachment: File | null;
  body: ChatBody;
}

/** Does this request carry an attachment alongside the conversation? */
export function isMultipartRequest(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("multipart/form-data") ?? false
  );
}

/**
 * The first bound, on the DECLARED body size, before anything is parsed (#1180).
 *
 * `request.formData()` materializes the whole multipart body, so checking only the
 * attachment afterwards would still have paid for the first copy. Absent or
 * unparseable `Content-Length` (a chunked body) falls through to the per-attachment
 * cap — this is a cheap door, not the only one.
 */
export function declaredBodyTooLarge(request: Request): boolean {
  const declaredLength = Number(request.headers.get("content-length"));
  return Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES;
}

/** Is this attachment over the contract's own cap, on its DECLARED size (#1180)? */
export function attachmentTooLarge(attachment: File | null): boolean {
  return (
    attachment !== null && attachment.size > ATTACHMENT_EXTRACTION_LIMITS_V1.maxBytes
  );
}

/**
 * Shape only, never size (#1408). Every size question — how much prose, how many
 * messages, how many attachment cards — is answered per model when the turn is
 * built, by shrinking rather than refusing. What is left here is what no amount of
 * shrinking can repair: a body that is not a conversation.
 */
export function parseChatBody(raw: unknown): ChatBody | null {
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

export async function readChatRequest(
  request: Request,
): Promise<ChatRequestInput | null> {
  if (!isMultipartRequest(request)) {
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

export function clientIp(request: Request): string | null {
  // x-real-ip is platform-set on Vercel; the RIGHTMOST forwarded hop is the
  // one appended by the proxy. The leftmost is client-controlled — keying the
  // rate limit on it would let a caller mint fresh buckets per request.
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",").at(-1)?.trim() || null;
}

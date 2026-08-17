/**
 * Fitting the conversation itself to the turn's budget (#1408).
 *
 * The sibling of `chat-history.ts`, which shrinks TOOL payloads, and it exists for
 * the same reason: the browser re-sends the whole conversation every turn, so a
 * server that refuses it once refuses it forever — the conversation does not fail,
 * it dies. Until #1408 the prose was the one budget that still refused, and the
 * report is the proof that it was reachable in normal use: an assistant reciting a
 * 425-row amortisation table (#1405) wrote past the ceiling in ONE answer, and the
 * panel could only say «recarga la página».
 *
 * Three claims are protected here, in this order:
 *
 * 1. **The turn in flight.** The last user message and everything after it is never
 *    dropped: dropping it would answer a question nobody asked.
 * 2. **Whole turns, newest first.** A pruned turn takes its answer with it, so the
 *    history never keeps a reply whose question is gone.
 * 3. **Text, only as a last resort.** When ONE message alone exceeds the budget —
 *    exactly the reported case — there is no turn left to drop, so its text is cut
 *    with a visible marker instead. This is what makes the fit unconditional; a
 *    turn-only strategy would still have to refuse that message.
 *
 * Nothing is announced to the user, deliberately: the panel keeps every message the
 * page has seen, so a warning would describe the model's memory, not the screen, and
 * would fire on turns where nothing was lost from view. What the MODEL is told is
 * another matter — the notes below reach it, and they forbid answering from its own
 * earlier prose (ADR 0048).
 */

import type { UIMessage } from "ai";
import { parseAttachmentPreviewData } from "./attachment-chat";
import {
  DROPPED_TOOL_PAYLOAD_NOTE,
  INTERRUPTED_PROPOSAL_NOTE,
  withoutToolParts,
} from "./chat-history";
import { FABRICATED_PROPOSAL_MODEL_NOTE } from "./fabricated-proposal";

type Part = UIMessage["parts"][number];

const ATTACHMENT_PART_TYPE = "data-attachment-extraction";

/**
 * Left once where the oldest turns were dropped. It forbids reusing earlier
 * figures for the same reason {@link DROPPED_TOOL_PAYLOAD_NOTE} does: answering
 * from its own previous prose instead of reading again is what ADR 0048 exists to
 * prevent, and here that prose is precisely what is no longer in context.
 */
export const DROPPED_TURNS_NOTE =
  "(Turnos anteriores de esta conversación retirados del historial por tamaño. No respondas de memoria sobre ellos: si te falta un dato, vuelve a llamar a la herramienta o pregunta al usuario.)";

/**
 * Left where an attachment card was dropped. It names the ONE recovery that works:
 * the file itself is never kept server-side (ADR 0044/0059), so no tool can read it
 * again — only the user can hand it over again.
 */
export const DROPPED_ATTACHMENT_NOTE =
  "(Documentos adjuntos anteriores retirados del historial por tamaño. Si necesitas sus datos, pide al usuario que vuelva a adjuntar el archivo: tú ya no puedes verlo.)";

/** Where a message's text was cut. Visible to the model on purpose. */
export const TRUNCATED_TEXT_MARKER =
  " […mensaje recortado por tamaño; no está completo…]";

/** How many shrink passes the text cut may take before it settles. */
const MAX_TRUNCATION_PASSES = 4;

/**
 * The notes the server writes into the history — these and the ones the tool-payload
 * repairs leave. The text cut skips them: they are instructions ABOUT the missing
 * context, so cutting one to make room would remove the sentence that stops the
 * model from answering out of its own memory. Together they are a few hundred
 * characters against a budget of tens of thousands.
 */
const SERVER_NOTES: ReadonlySet<string> = new Set([
  DROPPED_ATTACHMENT_NOTE,
  DROPPED_TOOL_PAYLOAD_NOTE,
  DROPPED_TURNS_NOTE,
  FABRICATED_PROPOSAL_MODEL_NOTE,
  INTERRUPTED_PROPOSAL_NOTE,
]);

export interface HistoryBudget {
  /** The conversation's own text (tool payloads and attachment cards excluded). */
  proseChars: number;
  /** Attachment preview cards surviving in history. */
  attachmentChars: number;
  /** Messages that may reach the provider at all. */
  maxMessages: number;
}

export interface HistoryFit {
  messages: UIMessage[];
  /** Ids of the messages dropped whole — by the count ceiling or as old turns. */
  droppedMessageIds: string[];
  /** Attachment cards removed to fit {@link HistoryBudget.attachmentChars}. */
  droppedAttachmentCards: number;
  /** Ids of the messages whose text had to be cut. */
  truncatedMessageIds: string[];
}

function isAttachmentPart(part: unknown): boolean {
  return (
    part !== null &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === ATTACHMENT_PART_TYPE
  );
}

/**
 * The two client-written sizes of a history, measured exactly as the budget spends
 * them: prose with the tool parts and the attachment cards taken out, cards on
 * their own. ONE function for measuring and for fitting, so the number that decides
 * cannot drift from the number that is charged.
 */
export function historySizes(messages: readonly unknown[]): {
  attachmentChars: number;
  proseChars: number;
} {
  let attachmentChars = 0;
  const counted = messages.map((message) => {
    if (message === null || typeof message !== "object") return message;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return message;
    return {
      ...message,
      parts: parts.filter((part) => {
        if (!isAttachmentPart(part)) return true;
        const preview = parseAttachmentPreviewData((part as { data?: unknown }).data);
        if (preview === null) return true;
        attachmentChars += JSON.stringify(preview).length;
        return false;
      }),
    };
  });
  return {
    attachmentChars,
    proseChars: JSON.stringify(withoutToolParts(counted)).length,
  };
}

/**
 * Prepends a note to the first surviving message, where the model reads it first.
 *
 * It lands in whatever role that message has, the user's included. Injecting server
 * text into a user message is already how an attachment reaches the model
 * (`prepareAttachmentMessagesForModel`), and the parenthesised form is the same one
 * the tool-payload repairs use, so the model reads it as an annotation rather than
 * as something the user said.
 */
function withLeadingNote(messages: UIMessage[], note: string): UIMessage[] {
  const [first, ...rest] = messages;
  if (!first) return messages;
  return [
    { ...first, parts: [{ type: "text" as const, text: note }, ...first.parts] },
    ...rest,
  ];
}

/**
 * Where the oldest droppable turn ends — the index the history may be cut at
 * without touching the turn in flight. Null when only that turn is left.
 *
 * A stretch of messages before the FIRST user message is a droppable turn of its
 * own: it is history the client sent with no question attached to it.
 */
function oldestTurnBoundary(messages: readonly UIMessage[]): number | null {
  const userIndexes = messages.flatMap((message, index) =>
    message.role === "user" ? [index] : [],
  );
  const first = userIndexes[0];
  if (first === undefined) return null;
  if (first > 0) return first;
  return userIndexes[1] ?? null;
}

/** Drops attachment cards, oldest first, until they fit their own budget. */
function fitAttachmentCards(
  messages: UIMessage[],
  attachmentChars: number,
): { messages: UIMessage[]; dropped: number } {
  const located = messages.flatMap((message, messageIndex) =>
    message.parts.flatMap((part, partIndex) => {
      if (!isAttachmentPart(part)) return [];
      const preview = parseAttachmentPreviewData((part as { data?: unknown }).data);
      if (preview === null) return [];
      return [
        { at: `${messageIndex}:${partIndex}`, chars: JSON.stringify(preview).length },
      ];
    }),
  );
  const drop = new Set<string>();
  let spent = 0;
  // Newest first: the card this turn is talking about is the one worth keeping.
  for (let index = located.length - 1; index >= 0; index -= 1) {
    const card = located[index]!;
    if (spent + card.chars <= attachmentChars) {
      spent += card.chars;
      continue;
    }
    drop.add(card.at);
  }
  if (drop.size === 0) return { dropped: 0, messages };

  return {
    dropped: drop.size,
    messages: messages
      .map((message, messageIndex) => {
        const kept = message.parts.filter(
          (_, partIndex) => !drop.has(`${messageIndex}:${partIndex}`),
        );
        if (kept.length === message.parts.length) return message;
        return {
          ...message,
          parts: [...kept, { type: "text" as const, text: DROPPED_ATTACHMENT_NOTE }],
        };
      })
      .filter((message) => message.parts.length > 0),
  };
}

/**
 * Cuts the text of the oldest messages until the prose fits. The LAST resort, and
 * it can reach the message the user just sent: a single pasted book has to be cut
 * somewhere, and cutting it with a marker the model can see beats refusing the turn
 * and asking the user to reload.
 *
 * Iterative because the measurement is of the serialized history: escaping makes a
 * cut of N characters worth slightly less than N in the total, so the remainder is
 * re-measured instead of predicted.
 */
function truncateTextToFit(
  messages: UIMessage[],
  proseChars: number,
  truncatedMessageIds: Set<string>,
): UIMessage[] {
  let current = messages;
  for (let pass = 0; pass < MAX_TRUNCATION_PASSES; pass += 1) {
    let overflow = historySizes(current).proseChars - proseChars;
    if (overflow <= 0) break;
    let progressed = false;
    current = current.map((message) => {
      if (overflow <= 0) return message;
      let changed = false;
      const parts = message.parts.map((part: Part) => {
        if (overflow <= 0 || part.type !== "text" || SERVER_NOTES.has(part.text)) {
          return part;
        }
        const text = part.text;
        const remove = Math.min(text.length, overflow + TRUNCATED_TEXT_MARKER.length);
        if (remove <= TRUNCATED_TEXT_MARKER.length) return part;
        overflow -= remove - TRUNCATED_TEXT_MARKER.length;
        changed = true;
        return {
          ...part,
          text: `${text.slice(0, text.length - remove)}${TRUNCATED_TEXT_MARKER}`,
        };
      });
      if (!changed) return message;
      progressed = true;
      truncatedMessageIds.add(message.id);
      return { ...message, parts };
    });
    if (!progressed) break;
  }
  return current;
}

/**
 * Shrinks a history until it fits `budget`, never refusing it.
 *
 * The budget comes from the model that is about to answer (`turn-prompt-budget.ts`),
 * so the same conversation may be kept whole for `gemini-3.1-flash-lite` and cut
 * hard for a narrow fallback. That is the point: before #1408 both were held to the
 * narrower one, permanently and by way of a 400.
 */
export function fitHistoryToBudget(
  messages: UIMessage[],
  budget: HistoryBudget,
): HistoryFit {
  const droppedMessageIds: string[] = [];
  let kept = messages;

  // The count ceiling FIRST, and that order is what bounds the cost: it no longer
  // refuses (turn 21 of a healthy conversation used to die on it), so everything
  // below re-measures a serialized history — cheap against 40 messages, quadratic
  // against the thousands a client is free to send inside the byte cap.
  if (kept.length > budget.maxMessages) {
    const window = kept.slice(-budget.maxMessages);
    // Cut on a turn boundary so the window never opens on an answer whose question
    // was left behind.
    const firstUser = window.findIndex((message) => message.role === "user");
    const trimmed = firstUser > 0 ? window.slice(firstUser) : window;
    droppedMessageIds.push(
      ...kept.slice(0, kept.length - trimmed.length).map((message) => message.id),
    );
    kept = trimmed;
  }

  const attachments = fitAttachmentCards(kept, budget.attachmentChars);
  kept = attachments.messages;

  let droppedTurn = false;
  while (historySizes(kept).proseChars > budget.proseChars) {
    const boundary = oldestTurnBoundary(kept);
    if (boundary === null) break;
    droppedMessageIds.push(...kept.slice(0, boundary).map((message) => message.id));
    kept = kept.slice(boundary);
    droppedTurn = true;
  }
  if (droppedMessageIds.length > 0 || droppedTurn) {
    kept = withLeadingNote(kept, DROPPED_TURNS_NOTE);
  }

  const truncatedMessageIds = new Set<string>();
  kept = truncateTextToFit(kept, budget.proseChars, truncatedMessageIds);

  return {
    droppedAttachmentCards: attachments.dropped,
    droppedMessageIds,
    messages: kept,
    truncatedMessageIds: [...truncatedMessageIds],
  };
}

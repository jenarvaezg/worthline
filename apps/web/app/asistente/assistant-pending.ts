/**
 * The visible «I am working on it» signal for a chat turn (#1286).
 *
 * Until now the only in-flight signal was an `srOnly` live region: a screen reader
 * was told the assistant was answering and everybody else saw an unchanged panel
 * with two disabled buttons. The worst case is the attachment path of PRD #1241,
 * where an unidentified capture pays TWO serial vision calls before the stream even
 * opens — extraction, then #1246's description with its own 12 s ceiling — so the
 * wait can run into tens of seconds with nothing on screen.
 *
 * The rule is a pure function of the conversation, deliberately: the label must go
 * away the moment the model's own words start arriving (tokens are better feedback
 * than any spinner), and «is there text yet» is a question about `messages`, not
 * about a timer or a ref. Whether the turn carried a file is read back off the
 * user's own turn (`attachment-notice.ts`), so no second copy of that state exists.
 */

import type { UIMessage } from "ai";

import { attachmentNoticeFileName } from "./attachment-notice";

/** The ordinary wait: the request is out and nothing has come back yet. */
export const ASSISTANT_PENDING_THINKING = "Pensando…";

/**
 * The long wait, named. A capture is read before the conversational turn starts, so
 * the user is not waiting for an answer yet — they are waiting for worthline to look
 * at their file, which is worth saying out loud rather than hiding behind «pensando».
 */
export const ASSISTANT_PENDING_READING = "Leyendo el adjunto…";

type Part = UIMessage["parts"][number];

function hasVisibleText(message: UIMessage): boolean {
  return message.parts.some(
    (part) => part.type === "text" && (part as { text: string }).text.trim() !== "",
  );
}

function isExtractionCard(part: Part): boolean {
  return part.type === "data-attachment-extraction";
}

/**
 * Whether the turn in flight is still waiting for its attachment to be read: the
 * last user turn named a file and no card has answered for it yet. The card is the
 * honest boundary — it is emitted once the vision seam has spoken, identified
 * document or not, so from then on the wait is the model's.
 */
function awaitsAttachmentReading(messages: readonly UIMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") continue;
    const named = message.parts.some(
      (part) =>
        part.type === "text" &&
        attachmentNoticeFileName((part as { text: string }).text) !== null,
    );
    if (!named) return false;
    return !messages.slice(index + 1).some((later) => later.parts.some(isExtractionCard));
  }
  return false;
}

/**
 * What the panel should show while a turn is in flight, or `null` for «show
 * nothing»: either no request is out, or the answer has already started to arrive.
 */
export function assistantPendingLabel({
  messages,
  status,
}: {
  messages: readonly UIMessage[];
  status: string;
}): string | null {
  if (status !== "submitted" && status !== "streaming") return null;
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === "assistant" && hasVisibleText(last))
    return null;
  return awaitsAttachmentReading(messages)
    ? ASSISTANT_PENDING_READING
    : ASSISTANT_PENDING_THINKING;
}

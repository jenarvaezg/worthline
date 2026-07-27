/**
 * The line that keeps a sent attachment visible in the user's own turn (#1285).
 *
 * The composer used to name the file ONLY when nothing was typed: attach and send
 * without a word and the turn read «Adjunto: x.csv», but type a sentence too and
 * the file left no trace anywhere — it travelled in the request body, the chip was
 * cleared on send, and the history that gets re-sent every turn never knew a
 * document had been there. This module is the one place that decides what a user
 * turn says about its attachment, so the two readings of that line cannot drift:
 * the composer WRITES it and the pending signal (#1286) READS it back to tell the
 * long wait (two serial vision calls) from an ordinary one.
 *
 * A user who types «Adjunto: algo» by hand is indistinguishable from a real
 * attachment here. That is accepted: the only consequence is a pending label that
 * names a file for a few seconds, and the alternative — a second channel of state
 * for the same fact — is how the two readings start disagreeing.
 */

/** How a turn names the file it carries. The prefix IS the marker. */
export const ATTACHMENT_NOTICE_PREFIX = "Adjunto: ";

/** The notice line for one file name. */
export function attachmentNotice(fileName: string): string {
  return `${ATTACHMENT_NOTICE_PREFIX}${fileName.trim()}`;
}

/**
 * The text of a user turn: what they typed, plus the notice when a file rides
 * along. Blank drafts collapse to the notice alone, which is what the drag-and-drop
 * path has always sent.
 */
export function userTurnText(draft: string, fileName: string | null): string {
  const typed = draft.trim();
  if (fileName === null || fileName.trim() === "") return typed;
  const notice = attachmentNotice(fileName);
  return typed === "" ? notice : `${typed}\n\n${notice}`;
}

/** The file name a sent turn names, or `null` when it carries none. */
export function attachmentNoticeFileName(text: string): string | null {
  const line = text
    .split("\n")
    .reverse()
    .find((candidate) => candidate.trimStart().startsWith(ATTACHMENT_NOTICE_PREFIX));
  if (line === undefined) return null;
  const fileName = line.trimStart().slice(ATTACHMENT_NOTICE_PREFIX.length).trim();
  return fileName === "" ? null : fileName;
}

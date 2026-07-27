/**
 * The assistant's prose never prints a public holding id (#1263).
 *
 * The id is machinery: it is how the model and its tools refer to a thing in the
 * patrimony, and it says nothing to the person reading. Printing it has exactly one
 * observable effect — when the model invents one, the invention arrives dressed as a
 * verified fact («he verificado los datos y el ID correcto es …»), and the reader has
 * no way to tell that apart from a real lookup.
 *
 * So the id is replaced by the holding's NAME, taken from the read that surfaced it:
 * the same conversation the user is looking at carries the tool outputs, so the name
 * is worthline's own fact and not a guess. An id nobody read resolves to a neutral
 * marker instead — it may be an invention, but it is also what a half-typed id looks
 * like while the answer streams, and a note that accuses a turn one moment before
 * withdrawing it is worse than no note (#1262).
 *
 * This is the cheap half of #1263 and it removes the whole user-visible surface; the
 * write path is guarded separately and for real in `holding-id-provenance.ts`.
 */

import { isToolUIPart, type UIMessage } from "ai";

import { isPublicHoldingId, replacePublicHoldingIdLookalikes } from "./public-holding-id";

/** What replaces an id the conversation never named. */
export const UNNAMED_HOLDING = "(identificador interno)";

/**
 * The holding names this conversation surfaced, by id.
 *
 * Read from tool OUTPUTS, so every name is worthline's own: the agent-view contract
 * pairs a public id with its `label` in every shape that carries one (the compact
 * context's holdings, the exposure's top holdings, a holding's detail, the trash).
 */
export function labelsByPublicHoldingId(
  messages: readonly UIMessage[],
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolUIPart(part) && "output" in part) {
        collectLabels(part.output, labels, new WeakSet());
      }
    }
  }
  return labels;
}

function collectLabels(
  value: unknown,
  into: Map<string, string>,
  seen: WeakSet<object>,
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectLabels(item, into, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  const { id, label } = record;
  if (typeof id === "string" && typeof label === "string" && isPublicHoldingId(id)) {
    into.set(id, label);
  }
  for (const nested of Object.values(record)) collectLabels(nested, into, seen);
}

/**
 * The same prose with every id replaced by the holding it names.
 *
 * Applies to the ASSISTANT's text only — what the user typed is rendered literally,
 * including an id they chose to paste (#1047).
 */
export function withoutPublicHoldingIds(
  text: string,
  labels: ReadonlyMap<string, string>,
): string {
  return replacePublicHoldingIdLookalikes(text, (token) => {
    const label = labels.get(token);
    return label === undefined ? UNNAMED_HOLDING : `«${label}»`;
  });
}

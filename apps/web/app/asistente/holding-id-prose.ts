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

import type { UIMessage } from "ai";

import {
  isPublicHoldingId,
  replacePublicHoldingIdLookalikes,
  UNNAMED_HOLDING,
} from "./public-holding-id";
import { toolOutputsIn } from "./tool-parts";
import { walkDeep } from "./walk-deep";

/** Re-exported so a caller of this module never has to reach past it for the marker. */
export { UNNAMED_HOLDING };

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
  for (const { output } of toolOutputsIn(messages)) {
    walkDeep(output, (_key, value) => {
      if (typeof value !== "object" || value === null) return;
      const { id, label } = value as { id?: unknown; label?: unknown };
      if (typeof id === "string" && typeof label === "string" && isPublicHoldingId(id)) {
        labels.set(id, label);
      }
    });
  }
  return labels;
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

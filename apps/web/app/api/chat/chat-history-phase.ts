/**
 * The four repairs the history gets before it is converted, in the ONE order they may
 * run (#1697, extracted from `route.ts`).
 *
 * The history is repaired before it is converted (#1260). A tool call whose result
 * never arrived — the provider died mid-stream — makes the SDK refuse the whole prompt,
 * and since the browser re-sends that history every turn, the conversation would be
 * dead for good. Every repair is logged, never silent: they count how often a provider
 * dies mid-tool-call, how much stale grounding a long conversation is dragging along,
 * and how often the model claims a ceremony it never got — the last one is the
 * frequency #1262 had no way to measure.
 *
 * THE ORDER IS THE POINT, and it used to live in comments inside a 500-line handler.
 * Both fabricated-claim corrections run FIRST, on the untouched history, because the
 * prune removes an interrupted `propose_*` / `raise_maintainer_alert` call and a turn
 * like that DID ask for the real thing. `chat-history-phase.test.ts` pins that
 * ordering, so a future reader cannot restore it by reading a comment and hoping.
 */

import type { CollapseBudget } from "@web/asistente/chat-history";
import {
  correctFabricatedMaintainerAlertClaims,
  correctFabricatedProposalClaims,
  dropStaleToolPayloads,
  pruneOrphanToolCalls,
} from "@web/asistente/chat-history";
import type { UIMessage } from "ai";

export function repairHistoryForModel(
  messages: UIMessage[],
  toolBudget: CollapseBudget,
): UIMessage[] {
  const corrected = correctFabricatedProposalClaims(messages);
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
  // The same repair for the OTHER fabricated ceremony (#1525). It runs here, before the
  // prune, for the same reason the proposal one does: its guard exempts an alert call
  // still in flight — the tool writes through the control plane before it returns — and
  // the prune below is what removes that part.
  const alerted = correctFabricatedMaintainerAlertClaims(corrected.messages);
  if (alerted.correctedMessageIds.length > 0) {
    // Distinct ids, like the line above: the browser re-sends the whole history every
    // turn, so one incident reappears in every later request and a bare tally would
    // grow with the length of the thread.
    console.info("Assistant claimed a maintainer alert it never raised", {
      messageIds: alerted.correctedMessageIds,
      turnsInThisHistory: alerted.correctedMessageIds.length,
    });
  }
  const pruned = pruneOrphanToolCalls(alerted.messages);
  if (pruned.orphanToolCallIds.length > 0) {
    console.info("Assistant history orphan calls pruned", {
      orphanToolCalls: pruned.orphanToolCallIds.length,
    });
  }
  const shrunk = dropStaleToolPayloads(pruned.messages, toolBudget);
  if (shrunk.droppedToolCallIds.length > 0) {
    console.info("Assistant history shrunk to fit", {
      droppedToolPayloads: shrunk.droppedToolCallIds.length,
    });
  }
  return shrunk.messages;
}

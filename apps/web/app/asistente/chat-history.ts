/**
 * Repairs on the history the browser sends back with every turn (#1260).
 *
 * The client keeps the whole conversation and re-sends it, so anything the server
 * refuses once it refuses forever: a conversation does not fail, it dies. What
 * these repairs buy is that its SIZE is never the reason: an oversized history is
 * shrunk here, never rejected. Two ceilings in the route still refuse outright and
 * are documented there — `MAX_MESSAGES` and the request's byte cap — so this is
 * not an unconditional promise.
 */

import { isToolUIPart, type UIMessage } from "ai";

import {
  FABRICATED_ALERT_MODEL_NOTE,
  messagesWithFabricatedMaintainerAlert,
} from "./fabricated-maintainer-alert";
import {
  FABRICATED_PROPOSAL_MODEL_NOTE,
  messagesWithFabricatedProposal,
} from "./fabricated-proposal";
import { isProposalToolPart, toolCallAnswered, toolPartName } from "./tool-parts";

type Part = UIMessage["parts"][number];

/**
 * Left ONCE per message whose tool payloads were dropped for size. It forbids
 * reusing the earlier figures on purpose: answering from its own previous prose
 * instead of reading again is what ADR 0048 exists to prevent.
 *
 * One note per message, not per payload: a marker per dropped part is a term that
 * grows with the NUMBER of parts, which nothing bounds, and a client can send
 * thousands of tiny ones in a single message.
 */
export const DROPPED_TOOL_PAYLOAD_NOTE =
  "(Lecturas anteriores retiradas del historial por tamaño. No uses cifras de tus respuestas anteriores: vuelve a llamar a la herramienta si necesitas el dato.)";

/**
 * Left where an interrupted PROPOSAL was pruned, so its promise is not left
 * standing. It says «no llegó a mostrarse» and NOT «no existe»: the `propose_*`
 * tools persist before returning, so a stream that died after `execute()` leaves a
 * proposal that IS there. Claiming otherwise would be the repair inventing a fact
 * about persisted state (ADR 0048), and no tool lets the model check.
 */
export const INTERRUPTED_PROPOSAL_NOTE =
  "(La propuesta anterior se interrumpió y no llegó a mostrarse. Si el usuario la quiere, vuelve a proponerla.)";

/**
 * A tool call that never answered. `convertToModelMessages` turns it into a
 * `tool-call` with no `tool-result`, and the SDK then refuses the whole prompt
 * (`MissingToolResultsError`) as soon as a user turn follows it — so a provider error
 * mid-tool-call would poison the conversation for good. The states that DO answer are
 * enumerated once, in `tool-parts`.
 */
function isOrphanToolCall(part: Part): boolean {
  return isToolUIPart(part) && !toolCallAnswered(part);
}

/**
 * Drops tool calls that never got a result. The prose that came with them stays:
 * it is what the user saw on screen, and the model simply calls the tool again.
 * A pruned PROPOSAL leaves a note instead, because there the surviving prose
 * («te preparo la propuesta») would stand as a promise the app never kept.
 */
export function pruneOrphanToolCalls(messages: UIMessage[]): {
  messages: UIMessage[];
  orphanToolCallIds: string[];
} {
  const orphanToolCallIds = messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts
          .filter(isOrphanToolCall)
          .map((part) => (part as { toolCallId: string }).toolCallId)
      : [],
  );
  if (orphanToolCallIds.length === 0) return { messages, orphanToolCallIds };

  const repaired = messages
    .map((message) => {
      if (message.role !== "assistant") return message;
      const orphans = message.parts.filter(isOrphanToolCall);
      if (orphans.length === 0) return message;
      const kept = message.parts.filter((part) => !isOrphanToolCall(part));
      return {
        ...message,
        parts: orphans.some(isProposalToolPart)
          ? [...kept, { type: "text" as const, text: INTERRUPTED_PROPOSAL_NOTE }]
          : kept,
      };
    })
    // A message whose only part was the orphan read carries nothing now.
    .filter((message) => message.parts.length > 0);
  return { messages: repaired, orphanToolCallIds };
}

/**
 * Appends a note to the turns named by `ids`, leaving every other message untouched.
 *
 * Shared by the two ceremony repairs below because the mechanics are the whole of what
 * they have in common: the claimed prose STAYS — it is what the user read, and rewriting
 * the model's previous words would make the history disagree with the screen — and the
 * fact is added after it. What differs is only which turns and which sentence.
 */
function appendModelNote(
  messages: UIMessage[],
  ids: ReadonlySet<string>,
  note: string,
): UIMessage[] {
  return messages.map((message) =>
    ids.has(message.id)
      ? { ...message, parts: [...message.parts, { text: note, type: "text" as const }] }
      : message,
  );
}

/**
 * Contradicts, in the model's own history, a turn that CLAIMED to have prepared a
 * proposal without calling any proposal tool (#1262).
 *
 * Since #1468 «fabricated» also covers the turn whose `propose_*` call ANSWERED with
 * something that is not a proposal — a rejection — because that is a turn whose claim is
 * just as false. The interrupted call is the one kind left out: {@link
 * pruneOrphanToolCalls} runs next and leaves {@link INTERRUPTED_PROPOSAL_NOTE} on it,
 * which says the truer thing — the `propose_*` tools persist before returning, so that
 * proposal may well exist and simply never reached the screen.
 *
 * ORDER MATTERS: this must run BEFORE {@link pruneOrphanToolCalls}. That repair removes
 * the interrupted call, and without the part there is nothing left to tell it apart from
 * a ceremony invented out of thin air. Its own test pins that difference.
 *
 * The claimed prose stays. It is what the user read, and rewriting the model's
 * previous words would make the history disagree with the screen.
 */
export function correctFabricatedProposalClaims(messages: UIMessage[]): {
  messages: UIMessage[];
  correctedMessageIds: string[];
} {
  // The history is never in flight, so no message is exempt here.
  const correctedMessageIds = [...messagesWithFabricatedProposal(messages, false)]
    .filter(([, kind]) => kind !== "interrupted")
    .map(([id]) => id);
  const corrected = new Set(correctedMessageIds);
  if (correctedMessageIds.length === 0) return { messages, correctedMessageIds };

  return {
    messages: appendModelNote(messages, corrected, FABRICATED_PROPOSAL_MODEL_NOTE),
    correctedMessageIds,
  };
}

/**
 * Contradicts, in the model's own history, a turn that claimed to have FILED AN
 * INCIDENT when no `raise_maintainer_alert` call in it came back with one (#1525).
 *
 * The sibling of {@link correctFabricatedProposalClaims}, and needed for the same
 * reason: without it the fabricated sentence is the model's own context next turn, and
 * the measured failure mode is doubling down — Jorge had to ask for a ticket number
 * before the assistant admitted there was none. It matters MORE here, because a
 * fabricated alert paints nothing on screen for the user to notice is missing.
 *
 * ORDER MATTERS, as with its sibling: this must run BEFORE {@link
 * pruneOrphanToolCalls}. The guard deliberately exempts a call still in flight — the
 * tool persists before it returns, so that alert may really exist — and the prune
 * removes exactly that part, leaving nothing to tell it apart from an invented one.
 */
export function correctFabricatedMaintainerAlertClaims(messages: UIMessage[]): {
  messages: UIMessage[];
  correctedMessageIds: string[];
} {
  // The history is never in flight, so no message is exempt here.
  const corrected = messagesWithFabricatedMaintainerAlert(messages, false);
  const correctedMessageIds = [...corrected];
  if (correctedMessageIds.length === 0) return { messages, correctedMessageIds };

  return {
    messages: appendModelNote(messages, corrected, FABRICATED_ALERT_MODEL_NOTE),
    correctedMessageIds,
  };
}

/** Every character of a tool part reaches the provider, not just its `output`. */
export function toolPartChars(part: Part): number {
  return JSON.stringify(part).length;
}

/**
 * A tool name longer than this cannot be one of ours (the longest is ~34 chars),
 * and the name is the ONE field the SDK writes twice — into the `tool-call` and
 * into the `tool-result`. Measured: a part with a 47 000-character `type` weighs
 * 47 234 in the body, fits a 48 000 ceiling, and lands 94 285 characters in the
 * prompt. Capping the name is what keeps the ceiling meaning what it says.
 */
const MAX_TOOL_NAME_CHARS = 64;

export interface CollapseBudget {
  /** Hard ceiling on ALL tool payloads reaching the provider from history. */
  totalChars: number;
  /** What the readings behind the freshest one share. */
  staleChars: number;
  /**
   * What ALL the proposals share, so a pile of them cannot starve the readings —
   * and, being a sub-budget of `totalChars`, cannot starve them by accident either.
   */
  proposalChars: number;
  /**
   * How many tool parts may survive at all. A ceiling in characters is not enough:
   * every kept part becomes a call plus a result, so thousands of tiny parts fit
   * the character budget and still triple the prompt. A real conversation carries
   * at most `MAX_STEPS` readings per turn, so a few dozen is all the grounding
   * there is.
   */
  maxParts: number;
}

/**
 * Drops the tool payloads that do not fit the turn's budget, newest first.
 *
 * DROPS the whole part — call and result together — rather than replacing its
 * payload. Removing both sides is safe (it is what {@link pruneOrphanToolCalls}
 * already relies on); what is forbidden is removing a result and leaving its call.
 * Replacing payloads instead would leave one part per dropped payload in the
 * prompt, and the number of parts is bounded by nothing: 10 000 tiny parts in a
 * single message turned a 619 000-character body into 2 338 652 characters of
 * prompt — a ceiling that inflates is not a ceiling.
 *
 * Three claims on the budget, in this order, because they are not worth the same:
 *
 * 1. **The freshest reading**, which is what this turn's answer stands on.
 * 2. **The proposals**, newest first, sharing {@link CollapseBudget.proposalChars}:
 *    one the user is about to confirm must still be visible when they say yes.
 * 3. **The older readings**, held to {@link CollapseBudget.staleChars}.
 *
 * The order matters and both extremes were wrong: charging the proposals last made
 * one vanish exactly when it mattered, and charging them first starved the reading
 * the answer needs today.
 *
 * Since no part is kept beyond `totalChars`, none survives with an implausible tool
 * name, and no more than {@link CollapseBudget.maxParts} survive at all, what
 * history contributes is bounded in every dimension whatever arrives — the CLIENT
 * writes these parts, so this is a ceiling on a hostile payload as much as on a
 * long conversation.
 */
export function dropStaleToolPayloads(
  messages: UIMessage[],
  budget: CollapseBudget,
): { messages: UIMessage[]; droppedToolCallIds: string[] } {
  const located = messages.flatMap((message, messageIndex) =>
    message.role === "assistant"
      ? message.parts.flatMap((part, partIndex) =>
          isToolUIPart(part) ? [{ at: `${messageIndex}:${partIndex}`, part }] : [],
        )
      : [],
  );
  if (located.length === 0) return { messages, droppedToolCallIds: [] };

  const drop = new Set<string>();
  const droppedToolCallIds: string[] = [];
  let spent = 0;
  let kept = 0;
  const admit = (
    entries: typeof located,
    allowance: number,
    groupCap = allowance,
  ): void => {
    let group = 0;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const { at, part } = entries[index]!;
      const size = toolPartChars(part);
      if (
        kept < budget.maxParts &&
        toolPartName(part).length <= MAX_TOOL_NAME_CHARS &&
        group + size <= groupCap &&
        spent + size <= allowance
      ) {
        spent += size;
        group += size;
        kept += 1;
        continue;
      }
      drop.add(at);
      droppedToolCallIds.push((part as { toolCallId: string }).toolCallId);
    }
  };
  const readings = located.filter(({ part }) => !isProposalToolPart(part));
  const freshestReading = readings.slice(-1);
  admit(freshestReading, budget.totalChars);
  admit(
    located.filter(({ part }) => isProposalToolPart(part)),
    budget.totalChars,
    budget.proposalChars,
  );
  admit(readings.slice(0, -1), budget.staleChars);
  if (drop.size === 0) return { messages, droppedToolCallIds };

  return {
    messages: messages
      .map((message, messageIndex) => {
        if (
          message.role !== "assistant" ||
          !message.parts.some((_, partIndex) => drop.has(`${messageIndex}:${partIndex}`))
        ) {
          return message;
        }
        const kept = message.parts.filter(
          (_, partIndex) => !drop.has(`${messageIndex}:${partIndex}`),
        );
        return {
          ...message,
          parts: [...kept, { type: "text" as const, text: DROPPED_TOOL_PAYLOAD_NOTE }],
        };
      })
      .filter((message) => message.parts.length > 0),
    droppedToolCallIds,
  };
}

/**
 * The conversation's prose, with the tool parts taken out so it can be measured
 * alone. Charging tool payloads to the prose ceiling is what killed healthy
 * conversations: ONE `get_snapshot_history` with per-position rows is 113 773
 * characters, seven times the whole-body ceiling it was being charged to.
 */
export function withoutToolParts(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (message === null || typeof message !== "object") return message;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return message;
    return {
      ...message,
      parts: parts.filter((part) => !isToolUIPart(part as Part)),
    };
  });
}

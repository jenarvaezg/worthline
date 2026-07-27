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
  claimsPreparedProposal,
  FABRICATED_PROPOSAL_MODEL_NOTE,
} from "./fabricated-proposal";
import { isProposalToolPart, toolPartName } from "./tool-parts";

type Part = UIMessage["parts"][number];

/**
 * The tool part states `convertToModelMessages` turns into a `tool-result`.
 * Every other state becomes a `tool-call` with no answer, and the SDK refuses the
 * whole prompt (`MissingToolResultsError`) as soon as a user turn follows it — so
 * a provider error mid-tool-call would otherwise poison the conversation for good.
 *
 * `approval-requested` / `approval-responded` are deliberately treated as orphans:
 * no chat tool in this repo requires approval, so such a part can only arrive from
 * a broken or hostile client, and dropping it is what keeps the turn answerable.
 */
const RESULT_BEARING_STATES: ReadonlySet<string> = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

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

function isOrphanToolCall(part: Part): boolean {
  return isToolUIPart(part) && !RESULT_BEARING_STATES.has(part.state);
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
 * Contradicts, in the model's own history, a turn that CLAIMED to have prepared a
 * proposal without calling any proposal tool (#1262).
 *
 * ORDER MATTERS: this must run BEFORE {@link pruneOrphanToolCalls}. That repair
 * removes a `propose_*` call whose stream died mid-flight, and a turn like that DID
 * ask for a real proposal — running afterwards would accuse it of fabricating one.
 * Its own test pins that difference.
 *
 * The claimed prose stays. It is what the user read, and rewriting the model's
 * previous words would make the history disagree with the screen.
 */
export function correctFabricatedProposalClaims(messages: UIMessage[]): {
  messages: UIMessage[];
  correctedMessageIds: string[];
} {
  const fabricated = (message: UIMessage): boolean =>
    message.role === "assistant" &&
    !message.parts.some(isProposalToolPart) &&
    claimsPreparedProposal(
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join("\n"),
    );

  const correctedMessageIds = messages.filter(fabricated).map((message) => message.id);
  if (correctedMessageIds.length === 0) return { messages, correctedMessageIds };

  return {
    messages: messages.map((message) =>
      fabricated(message)
        ? {
            ...message,
            parts: [
              ...message.parts,
              { text: FABRICATED_PROPOSAL_MODEL_NOTE, type: "text" as const },
            ],
          }
        : message,
    ),
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

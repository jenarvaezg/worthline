/**
 * Repairs on the history the browser sends back with every turn (#1260).
 *
 * The client keeps the whole conversation and re-sends it, so anything the server
 * refuses once it refuses forever: a conversation does not fail, it dies. The
 * invariant these repairs buy is that **a conversation never dies because of its
 * own history** — the history is shrunk, never rejected.
 */

import { isToolUIPart, type UIMessage } from "ai";

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

function toolName(part: Part): string {
  const { type, toolName: dynamicName } = part as { type: string; toolName?: string };
  return type === "dynamic-tool" ? (dynamicName ?? "") : type.slice("tool-".length);
}

function isProposalPart(part: Part): boolean {
  return toolName(part).startsWith("propose_");
}

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
        parts: orphans.some(isProposalPart)
          ? [...kept, { type: "text" as const, text: INTERRUPTED_PROPOSAL_NOTE }]
          : kept,
      };
    })
    // A message whose only part was the orphan read carries nothing now.
    .filter((message) => message.parts.length > 0);
  return { messages: repaired, orphanToolCallIds };
}

/** Every character of a tool part reaches the provider, not just its `output`. */
export function toolPartChars(part: Part): number {
  return JSON.stringify(part).length;
}

export interface CollapseBudget {
  /** Hard ceiling on ALL tool payloads reaching the provider from history. */
  totalChars: number;
  /** What the readings behind the freshest one share. */
  staleChars: number;
  /**
   * How many tool parts may survive at all. A ceiling in characters is not enough:
   * the SDK expands every kept part into a `tool-call` PLUS a `tool-result`, with
   * the tool name in both, so thousands of tiny parts fit the character budget and
   * still triple it in the prompt. A real conversation carries at most
   * `MAX_STEPS` readings per turn, so a few dozen is all the grounding there is.
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
 * Two allowances, because the payloads are not worth the same, and PROPOSALS
 * reserve their room BEFORE the readings take it: a proposal the user is about to
 * confirm must still be visible when they say yes, and charging it after a fresh
 * reading is what made it disappear exactly when it mattered. The freshest reading
 * may then use what is left of {@link CollapseBudget.totalChars}, and everything
 * older is held to {@link CollapseBudget.staleChars} of the same running total.
 *
 * Since no part is kept beyond `totalChars` and no more than
 * {@link CollapseBudget.maxParts} survive at all, what history contributes is
 * bounded in both dimensions whatever arrives — the CLIENT writes these parts, so
 * this is a ceiling on a hostile payload as much as on a long conversation.
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
    allowanceOf: (isFreshest: boolean) => number,
  ): void => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const { at, part } = entries[index]!;
      const size = toolPartChars(part);
      if (
        kept < budget.maxParts &&
        spent + size <= allowanceOf(index === entries.length - 1)
      ) {
        spent += size;
        kept += 1;
        continue;
      }
      drop.add(at);
      droppedToolCallIds.push((part as { toolCallId: string }).toolCallId);
    }
  };
  admit(
    located.filter(({ part }) => isProposalPart(part)),
    () => budget.totalChars,
  );
  admit(
    located.filter(({ part }) => !isProposalPart(part)),
    (isFreshest) => (isFreshest ? budget.totalChars : budget.staleChars),
  );
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

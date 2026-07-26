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
 * What the model reads in place of a tool result retired for size. It forbids
 * reusing the earlier figures on purpose: answering from its own previous prose
 * instead of reading again is what ADR 0048 exists to prevent.
 */
export const RETIRED_TOOL_OUTPUT = {
  retirado:
    "Resultado retirado del historial por tamaño. No uses cifras de tu respuesta anterior: vuelve a llamar a la herramienta si necesitas el dato.",
} as const;

/** Left where an interrupted PROPOSAL was pruned, so its promise is not left standing. */
export const INTERRUPTED_PROPOSAL_NOTE =
  "(La propuesta anterior se interrumpió: no llegó a prepararse y no existe. Si el usuario la quiere, vuelve a proponerla.)";

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

/**
 * A retired part, rebuilt from scratch rather than edited: `input`, `rawInput`,
 * `errorText` and `approval.reason` all reach the prompt too, so swapping only
 * `output` would leave both the payload and its cost untouched.
 */
function retiredPart(part: Part): Part {
  const {
    type,
    toolCallId,
    toolName: dynamicName,
  } = part as { type: string; toolCallId: string; toolName?: string };
  return {
    ...(type === "dynamic-tool" ? { type, toolName: dynamicName } : { type }),
    toolCallId,
    state: "output-available",
    input: {},
    output: RETIRED_TOOL_OUTPUT,
  } as unknown as Part;
}

export interface CollapseBudget {
  /** Hard ceiling on ALL tool payloads reaching the provider in one turn. */
  totalChars: number;
  /** What the readings behind the freshest one share. */
  staleChars: number;
}

/**
 * Retires tool payloads, newest first, until the turn fits its budget.
 *
 * The call/result PAIR always survives — only the payload is swapped — because
 * dropping a result while keeping its call is exactly the poison {@link
 * pruneOrphanToolCalls} exists to clean up.
 *
 * The rule is cumulative: a part is kept only if everything kept so far PLUS
 * itself fits its allowance. Two allowances, because the payloads are not worth
 * the same — the freshest reading and any PROPOSAL may use the whole ceiling (the
 * first is what this turn's answer stands on; a proposal must still be visible
 * when the user says yes), and everything older is held to
 * {@link CollapseBudget.staleChars} of the same running total. So a large freshest
 * reading leaves the stale ones nothing, on purpose.
 *
 * Since no part is ever kept beyond `totalChars`, the total is bounded whatever
 * arrives — the CLIENT writes these parts, so this is a ceiling on a hostile
 * payload as much as on a long conversation.
 */
export function collapseStaleToolOutputs(
  messages: UIMessage[],
  budget: CollapseBudget,
): { messages: UIMessage[]; collapsedToolCallIds: string[] } {
  const chronological: Array<{ at: string; part: Part }> = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    message.parts.forEach((part, partIndex) => {
      if (isToolUIPart(part)) {
        chronological.push({ at: `${messageIndex}:${partIndex}`, part });
      }
    });
  });

  const retire = new Set<string>();
  const collapsedToolCallIds: string[] = [];
  let spent = 0;
  for (let index = chronological.length - 1; index >= 0; index -= 1) {
    const { at, part } = chronological[index]!;
    const allowance =
      index === chronological.length - 1 || isProposalPart(part)
        ? budget.totalChars
        : budget.staleChars;
    const size = toolPartChars(part);
    if (spent + size <= allowance) {
      spent += size;
      continue;
    }
    retire.add(at);
    collapsedToolCallIds.push((part as { toolCallId: string }).toolCallId);
  }
  if (retire.size === 0) return { messages, collapsedToolCallIds };

  return {
    messages: messages.map((message, messageIndex) =>
      message.role === "assistant" &&
      message.parts.some((_, partIndex) => retire.has(`${messageIndex}:${partIndex}`))
        ? {
            ...message,
            parts: message.parts.map((part, partIndex) =>
              retire.has(`${messageIndex}:${partIndex}`) ? retiredPart(part) : part,
            ),
          }
        : message,
    ),
    collapsedToolCallIds,
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

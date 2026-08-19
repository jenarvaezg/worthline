/**
 * Reading a tool part's identity off a `UIMessage`.
 *
 * Shared because two unrelated guards need the same question answered — the
 * history repairs (#1260) and the fabricated-ceremony check (#1262) — and the
 * answer is not a one-liner: a dynamic tool carries its name in `toolName` while
 * a static one hides it in the `tool-<name>` type string.
 */

import { isToolUIPart, type UIMessage } from "ai";

type Part = UIMessage["parts"][number];

/** The tool's name, whichever way the part spells it. `""` when unnamed. */
export function toolPartName(part: Part): string {
  const { type, toolName } = part as { type: string; toolName?: string };
  return type === "dynamic-tool" ? (toolName ?? "") : type.slice("tool-".length);
}

/**
 * A tool that asks worthline to PREPARE a write.
 *
 * The `propose_*` prefix is a convention, not a type: nothing forces a new tool to
 * adopt it. Leaning on it is nonetheless the right call here, because the
 * unvalidated-evidence frontier (#1248) enumerates proposal tools the same way — a
 * write tool named otherwise would already walk past a boundary that guards money,
 * which is a far louder failure than this check missing it.
 *
 * Takes a bare name, not a part, because the eval harness (#1265) asks the same
 * question about a `generateText` tool call: the number the admission gate reports
 * for the write path and the guard that runs in production must not be able to
 * disagree about what a proposal is.
 */
export function isProposalToolName(name: string): boolean {
  return name.startsWith("propose_");
}

/** {@link isProposalToolName} for a message part. */
export function isProposalToolPart(part: Part): boolean {
  return isToolUIPart(part) && isProposalToolName(toolPartName(part));
}

/**
 * The tool part states `convertToModelMessages` turns into a `tool-result` — which is
 * also, read the other way, the states in which the call CAME BACK: with an output, with
 * an error, or denied. Every other state is a call still in flight, or one whose stream
 * died before it answered.
 *
 * `approval-requested` / `approval-responded` are deliberately excluded: no chat tool in
 * this repo requires approval, so such a part can only arrive from a broken or hostile
 * client.
 */
const ANSWERED_STATES: ReadonlySet<string> = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

/**
 * Did this tool call come back at all?
 *
 * Two readers, one set: the history repair prunes the calls that never answered (#1260,
 * or `convertToModelMessages` kills the conversation), and the fabricated-ceremony guard
 * tells a REJECTED proposal apart from one whose stream died mid-flight (#1468) — the
 * screen shows no card either way, but only the first is worth telling the model.
 */
export function toolCallAnswered(part: Part): boolean {
  return isToolUIPart(part) && ANSWERED_STATES.has((part as { state: string }).state);
}

/** One tool answer in a conversation: which tool spoke, and what it said. */
export interface ToolOutput {
  name: string;
  output: unknown;
}

/**
 * Every tool answer in a conversation, in order.
 *
 * Shared for the same reason as the rest of this module: two readings of the same
 * history — the ids a write may point at and the names its prose may use (#1263) —
 * must not disagree about which parts count as an answer. Deliberately paired with
 * the tool's NAME, because what an output means depends on who wrote it: a read
 * asserts a workspace fact, `suggest_actions` echoes the model's own words back.
 */
export function toolOutputsIn(messages: readonly UIMessage[]): ToolOutput[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      isToolUIPart(part) && "output" in part
        ? [{ name: toolPartName(part), output: part.output }]
        : [],
    ),
  );
}

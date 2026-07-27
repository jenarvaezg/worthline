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

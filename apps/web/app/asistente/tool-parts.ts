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
 * A part that asked worthline to PREPARE a write.
 *
 * The `propose_*` prefix is a convention, not a type: nothing forces a new tool to
 * adopt it. Leaning on it is nonetheless the right call here, because the
 * unvalidated-evidence frontier (#1248) enumerates proposal tools the same way — a
 * write tool named otherwise would already walk past a boundary that guards money,
 * which is a far louder failure than this check missing it.
 */
export function isProposalToolPart(part: Part): boolean {
  return isToolUIPart(part) && toolPartName(part).startsWith("propose_");
}

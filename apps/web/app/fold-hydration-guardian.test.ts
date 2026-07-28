/**
 * Fold hydration guardian (#1270): every `<details>` must declare that the DOM
 * owns its `open` attribute.
 *
 * A fold carries zero client JS (ADR 0009, ADR 0036), so the BROWSER toggles
 * `open` when the person clicks the `<summary>` — React never sees it. Toggle one
 * before the page hydrates (slow network, cold route) and the server HTML says
 * «closed» while the DOM says «open»; React then logs an attribute mismatch it
 * refuses to patch up, which is a real `console.error` in a real person's console
 * (and what tinted e2e journeys red under `next dev`, #1270).
 *
 * `suppressHydrationWarning` is the declaration React offers for exactly this:
 * «this attribute is the DOM's, not mine». It silences nothing that matters — the
 * fold's open state genuinely belongs to whoever clicked it.
 *
 * The rule is UNCONDITIONAL, including the folds that pass `open`. That looks
 * over-broad and isn't: no fold in this app derives `open` from client state.
 * `open={editing}` is a server component reading a form error
 * (`formError?.formId === editFormId`), and `<details className="recentOpsPanel"
 * open>` is a literal. Nothing re-renders when the person toggles it, so the
 * browser is the owner there too — and a fold the server sent OPEN mismatches in
 * the other direction when it is clicked shut early. Should a fold ever drive
 * `open` from `useState`, React becomes the owner and this rule is the thing to
 * revisit — not the exemption to smuggle in.
 *
 * The end-to-end proof that the declaration works lives in
 * `e2e/49-fold-before-hydration.spec.ts`; this guardian is what keeps the next
 * `<details>` from being written without it.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { readSourceFiles, stripComments } from "./guardian-walk";

/**
 * Every `<details …>` opening tag in `source`, comments stripped so prose about
 * folds never counts as one.
 *
 * Scans to the tag's own closing `>` while tracking `{}` depth, so a JSX
 * expression attribute (`open={editing}`, `className={`tier ${x}`}`) cannot end
 * the tag early and hide the attributes that follow it.
 */
function foldOpeningTags(source: string): string[] {
  const text = stripComments(source);
  const tags: string[] = [];
  let index = text.indexOf("<details");
  while (index !== -1) {
    let depth = 0;
    let cursor = index;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) break;
      cursor += 1;
    }
    tags.push(text.slice(index, cursor + 1));
    index = text.indexOf("<details", cursor);
  }
  return tags;
}

/** Whether the tag declares the DOM as the owner of `open`. */
function declaresDomOwnership(tag: string): boolean {
  return tag.includes("suppressHydrationWarning");
}

describe("fold hydration guardian (#1270)", () => {
  test("every <details> in the web app declares suppressHydrationWarning", () => {
    // The whole app, not just `app/`: a fold added beside it would otherwise slip
    // past a guardian that only looked at the routes.
    const offenders = readSourceFiles(join(import.meta.dirname, ".."))
      .flatMap(({ filePath, source }) =>
        foldOpeningTags(source).map((tag) => ({ filePath, tag })),
      )
      .filter(({ tag }) => !declaresDomOwnership(tag))
      .map(
        ({ filePath, tag }) =>
          `${filePath.slice(import.meta.dirname.length + 1)}: ${tag.replace(/\s+/g, " ")}`,
      );

    expect(
      offenders,
      "a <details> whose `open` the browser toggles before hydration must carry " +
        "`suppressHydrationWarning` (ADR 0036, #1270) — otherwise React logs an " +
        "unpatchable attribute mismatch when a person opens it early",
    ).toEqual([]);
  });

  describe("the scan itself", () => {
    test("reads a multi-line tag whole, JSX expressions included", () => {
      expect(
        foldOpeningTags(
          `<details\n  className={\`tier ${"${x}"}\`}\n  open={editing}\n>\n<summary/>\n</details>`,
        ),
      ).toHaveLength(1);
      expect(
        foldOpeningTags(`<details className={cx({ a: 1 })} suppressHydrationWarning>`)[0],
      ).toContain("suppressHydrationWarning");
    });

    test("ignores folds named in prose", () => {
      expect(
        foldOpeningTags(`/** A fold is a <details> element. */\nconst a = 1;`),
      ).toEqual([]);
    });

    test("sees a fold whether the declaration is there or not", () => {
      expect(declaresDomOwnership(`<details className="confirmDelete">`)).toBe(false);
      expect(
        declaresDomOwnership(`<details suppressHydrationWarning className="anchorEdit">`),
      ).toBe(true);
      // Multi-line, as biome formats the wider tags.
      expect(
        declaresDomOwnership(
          `<details\n  suppressHydrationWarning\n  className="historicoMoverDetails"\n>`,
        ),
      ).toBe(true);
    });
  });
});

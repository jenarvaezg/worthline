/**
 * Wiring test for the «Traer de otra entidad» surface (#1518). Renders the island to
 * static markup and asserts the shape of the flow: the five fields under the names
 * the action reads back, the live participaciones line, and the two optional notes
 * saying what leaving each field empty MEANS.
 *
 * As in the «Traspasar» sibling, no blocking native constraint anywhere: what makes
 * a figure obligatory is the server (`planExternalTransferIn`), and a `required`
 * that ever ends up inside a hidden pane aborts the submit of the whole form (#677).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import ExternalEntrySection from "./external-entry-section";

const TODAY = "2026-08-31";
const noop = async () => {};

function render(over: Partial<Parameters<typeof ExternalEntrySection>[0]> = {}): string {
  return renderToStaticMarkup(
    <ExternalEntrySection
      currentUrl="/patrimonio/n5396/editar"
      formError={null}
      holdingName="MyInvestor Indexado Global PP"
      recordAction={noop}
      today={TODAY}
      {...over}
    />,
  );
}

describe("ExternalEntrySection", () => {
  test("posts the five fields under the names the action reads", () => {
    const markup = render();

    for (const name of ["trAmount", "trPrice", "trDate", "trCost", "trSeniority"]) {
      expect(markup).toContain(`name="${name}"`);
    }
    expect(markup).toContain('name="currentUrl"');
  });

  test("says out loud that this is not a purchase", () => {
    // The whole reason the door exists: the two readings it replaces are a `buy`,
    // which eats a year of cupo, and a pair that promises an origin outside the book.
    expect(render()).toContain("no consume cupo de aportación");
  });

  test("the landing date defaults to today; the seniority defaults to nothing", () => {
    const markup = render();

    expect(markup).toMatch(new RegExp(`name="trDate"[^>]*value="${TODAY}"`));
    // «Hoy» is a sensible guess for when capital arrived and a terrible one for how
    // old it is: an empty field reads as «no lo sé», which is what gets stored.
    expect(markup).toMatch(/name="trSeniority"[^>]*value=""/);
  });

  test("the empty seniority explains what it costs to leave it empty", () => {
    expect(render()).toContain("qué parte se puede rescatar");
  });

  test("no native constraint blocks the submit", () => {
    expect(render()).not.toMatch(/<input[^>]*\brequired\b/);
  });

  test("demo disables the submit instead of lying about it", () => {
    const markup = render({ readOnly: true });

    expect(markup).toContain("disabled");
    expect(markup).not.toContain('type="submit"');
  });

  test("a refused entry comes back with its fields typed and its message shown", () => {
    const markup = render({
      formError: {
        formId: "externalEntry",
        message: "Necesito el valor liquidativo de la inversión de destino.",
        values: { trAmount: "4979,55", trCost: "4000,00" },
      },
    });

    expect(markup).toContain("Necesito el valor liquidativo");
    expect(markup).toMatch(/name="trAmount"[^>]*value="4979,55"/);
    expect(markup).toMatch(/name="trCost"[^>]*value="4000,00"/);
  });
});

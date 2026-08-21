/**
 * Wiring test for the «Traspasar» surface (#1480). Renders the island to static
 * markup and asserts the shape of the flow: the destination search + picker with its
 * «crear una nueva» exit, the single date, the importe with its «todo» alternative,
 * the two VLs prefilled from the cached prices, and the live preview line.
 *
 * The load-bearing assertion is the LAST one. This is ONE form with a pane hidden by
 * CSS, and a native `required` inside `display:none` makes Chrome and Firefox abort
 * the submit of the whole form — for every path, not just the hidden one — while
 * tests that post FormData straight to the action stay green (#677, measured in the
 * add wizard). So: no blocking native constraint, anywhere in this form. What makes
 * the destination's name obligatory is the server.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { TransferDestinationOption } from "./transfer-form";
import TransferSection from "./transfer-section";

const TODAY = "2026-08-21";
const ORIGIN = {
  assetId: "h-origen",
  costBasisMinor: 100_000,
  pricePerUnit: "12.00",
  unitsHeld: "100",
};
const DESTINATIONS: TransferDestinationOption[] = [
  { assetId: "h-cartera", name: "Cartera Permanente PP", pricePerUnit: "14.50" },
  { assetId: "h-value", name: "Value PP" },
];

const noop = async () => {};

function render(
  over: {
    destinations?: TransferDestinationOption[];
    formError?: Parameters<typeof TransferSection>[0]["formError"];
    readOnly?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    <TransferSection
      currentUrl="/patrimonio/h-origen/editar"
      destinations={over.destinations ?? DESTINATIONS}
      formError={over.formError ?? null}
      origin={ORIGIN}
      originName="Indexado PP"
      readOnly={over.readOnly ?? false}
      recordAction={noop}
      today={TODAY}
    />,
  );
}

describe("TransferSection", () => {
  test("offers every existing holding plus the exit to create a new one", () => {
    const html = render();

    expect(html).toContain('value="h-cartera"');
    expect(html).toContain("Cartera Permanente PP");
    expect(html).toContain('value="h-value"');
    expect(html).toContain('value="__new__"');
    expect(html).toContain("Crear una inversión nueva");
  });

  test("asks the date once, the importe once, and each VL separately", () => {
    const html = render();

    expect(html).toContain('name="executedAt"');
    expect(html).toContain('name="amount"');
    expect(html).toContain('name="originPricePerUnit"');
    expect(html).toContain('name="destinationPricePerUnit"');
    // One form, one submit: no second screen to confirm on.
    expect(html.match(/<form/g)).toHaveLength(1);
  });

  test("«todo» is offered as its own choice, naming the position it would empty", () => {
    const html = render();

    expect(html).toContain('value="all"');
    expect(html).toContain("Todo (100 participaciones)");
  });

  test("the origin's cached price arrives prefilled, in es-ES", () => {
    expect(render()).toContain('value="12"');
  });

  test("the preview line asks for what is missing instead of shouting an error", () => {
    const html = render();

    expect(html).toContain("cuántas participaciones se mueven");
    expect(html).not.toContain("errorBand");
  });

  test("a rejected submit round-trips its message and its typed values", () => {
    const html = render({
      formError: {
        formId: "transfer",
        message: "Ese importe son 416,666667 participaciones y solo hay 100.",
        values: { amount: "5.000,00", destinationPricePerUnit: "14,50" },
      },
    });

    expect(html).toContain("Ese importe son 416,666667 participaciones");
    expect(html).toContain('value="5.000,00"');
    expect(html).toContain('value="14,50"');
  });

  test("a backdated traspaso is told its prefilled VLs are today's, not that day's", () => {
    expect(render()).not.toContain("no es de hoy");

    const backdated = render({
      formError: {
        formId: "transfer",
        message: "",
        values: { executedAt: "2026-08-14" },
      },
    });

    expect(backdated).toContain("El traspaso no es de hoy");
  });

  test("demo disables the submit rather than letting the guard bounce it", () => {
    expect(render({ readOnly: true })).toContain("disabled");
  });

  test("NO field carries a native blocking constraint — the hidden-pane trap (#677)", () => {
    const html = render();

    expect(html).not.toContain("required");
    expect(html).not.toContain("pattern=");
    expect(html).not.toContain("min=");
    expect(html).not.toContain("max=");
  });
});

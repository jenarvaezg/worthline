import {
  labelsByPublicHoldingId,
  UNNAMED_HOLDING,
  withoutPublicHoldingIds,
} from "@web/asistente/holding-id-prose";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

const READ = "wl_hld_c5d97d4b4a1b9d7b42f2b7a976f0d14b";
const INVENTED = "wl_hld_3d4408012674258705c93c4e320f750d";

function toolMessage(output: unknown): UIMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: [
      {
        type: "tool-get_financial_context",
        toolCallId: "c1",
        state: "output-available",
        input: {},
        output,
      } as unknown as UIMessage["parts"][number],
    ],
  };
}

describe("labelsByPublicHoldingId", () => {
  it("pairs every id a read surfaced with its label, at any depth", () => {
    const labels = labelsByPublicHoldingId([
      toolMessage({
        holdings: [{ id: READ, object: "holding", label: "Préstamos Revolut" }],
        exposure: { topHoldings: [{ id: INVENTED, label: "Fondo Global" }] },
      }),
    ]);
    expect(labels.get(READ)).toBe("Préstamos Revolut");
    expect(labels.get(INVENTED)).toBe("Fondo Global");
  });

  it("ignores an id-shaped value with no label next to it", () => {
    const labels = labelsByPublicHoldingId([
      toolMessage({ holding: READ, asOf: "2026" }),
    ]);
    expect(labels.size).toBe(0);
  });

  it("ignores what the model only wrote in prose", () => {
    const labels = labelsByPublicHoldingId([
      {
        id: "m1",
        role: "assistant",
        parts: [{ type: "text", text: `el ID es ${READ} («Hipoteca»)` }],
      },
    ]);
    expect(labels.size).toBe(0);
  });
});

describe("withoutPublicHoldingIds", () => {
  const labels = new Map([[READ, "Préstamos Revolut"]]);

  it("replaces a read id with the holding's name", () => {
    expect(
      withoutPublicHoldingIds(`El ID del holding de tu préstamo es \`${READ}\`.`, labels),
    ).toBe("El ID del holding de tu préstamo es «Préstamos Revolut».");
  });

  it("replaces an id nobody read with a neutral marker", () => {
    // The turn of the incident: a second, different id presented as verified.
    expect(
      withoutPublicHoldingIds(
        `He verificado los datos y el ID correcto es ${INVENTED}`,
        labels,
      ),
    ).toBe(`He verificado los datos y el ID correcto es ${UNNAMED_HOLDING}`);
  });

  it("replaces the malformed id shape too", () => {
    expect(withoutPublicHoldingIds("uso wl_hld_mortgage_id_placeholder ya", labels)).toBe(
      `uso ${UNNAMED_HOLDING} ya`,
    );
  });

  it("leaves an answer with no ids exactly as written", () => {
    const text = "Tu hipoteca son 84.000 € a 19/06/2026, tras la amortización de mayo.";
    expect(withoutPublicHoldingIds(text, labels)).toBe(text);
  });

  it("replaces every occurrence in the same answer", () => {
    expect(withoutPublicHoldingIds(`${READ} y ${READ}`, labels)).toBe(
      "«Préstamos Revolut» y «Préstamos Revolut»",
    );
  });
});

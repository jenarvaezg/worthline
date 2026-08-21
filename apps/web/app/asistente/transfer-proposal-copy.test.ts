import { describe, expect, it } from "vitest";

import {
  transferDictatedLine,
  transferHalfLine,
  transferInheritedCostLine,
  transferPriceProvenanceNote,
  transferSideLine,
} from "./transfer-proposal-copy";

describe("transfer proposal copy (#1482)", () => {
  it("echoes the importe and the date worthline read, in es-ES", () => {
    expect(
      transferDictatedLine({
        currency: "EUR",
        executedAt: "2026-08-21",
        portion: { amountMinor: 73922, kind: "amount" },
      }),
    ).toBe("21/08/2026 · 739,22\u00a0€");
  });

  it("prints «todo» as itself, never as the importe it equals", () => {
    expect(
      transferDictatedLine({
        currency: "EUR",
        executedAt: "2026-08-21",
        portion: { kind: "all" },
      }),
    ).toBe("21/08/2026 · todo el saldo");
  });

  it("keeps every decimal of a VL a plan de pensiones quotes", () => {
    expect(
      transferHalfLine({
        amountMinor: 73922,
        currency: "EUR",
        pricePerUnit: "19.87091",
        units: "37.203",
      }),
    ).toBe("37,203 part. × 19,87091 € · 739,22\u00a0€");
  });

  it("names both sides with their participaciones before → after", () => {
    expect(
      transferSideLine({
        direction: "out",
        name: "Myinvestor Global PP",
        unitsAfter: "804.059",
        unitsBefore: "841.262",
      }),
    ).toBe("Salen de «Myinvestor Global PP»: 841,262 → 804,059 participaciones");
    expect(
      transferSideLine({
        direction: "in",
        name: "Indexa RV",
        unitsAfter: "50.98",
        unitsBefore: "0",
      }),
    ).toBe("Entran en «Indexa RV»: 0 → 50,98 participaciones");
  });

  it("names the cost that travels", () => {
    expect(transferInheritedCostLine(61245, "EUR")).toBe(
      "Coste de adquisición que viaja: 612,45\u00a0€",
    );
  });

  it("says nothing when the VL is the transfer date's own quoted price", () => {
    expect(
      transferPriceProvenanceNote({
        executedAt: "2026-08-21",
        manual: false,
        name: "World",
        priceDate: "2026-08-21",
        pricePerUnit: "19.87091",
        side: "origin",
      }),
    ).toBeNull();
  });

  it("says which day a borrowed VL is from, and where the VL is a field", () => {
    const note = transferPriceProvenanceNote({
      executedAt: "2026-08-21",
      manual: false,
      name: "World",
      priceDate: "2026-08-19",
      pricePerUnit: "19.87091",
      side: "origin",
    });

    expect(note).toContain("es del 19/08/2026");
    expect(note).toContain("no el del 21/08/2026");
    expect(note).toContain("«Traspasar»");
  });

  it("says so when the VL is one the user typed by hand", () => {
    expect(
      transferPriceProvenanceNote({
        executedAt: "2026-08-21",
        manual: true,
        name: "Plan de pensiones",
        pricePerUnit: "14.5",
        side: "destination",
      }),
    ).toContain("a mano");
  });
});

import type { MyInvestorProductRow } from "@web/ajustes/myinvestor-selection";
import { describe, expect, test } from "vitest";

import {
  myInvestorHistoryLine,
  myInvestorRowNotes,
  myInvestorRowState,
  myInvestorSinceLabel,
} from "./myinvestor-first-start-view";

const ROW: MyInvestorProductRow = {
  accountKey: "securities:1",
  block: null,
  identifier: "IE00B03HD191",
  inheritedCostPending: false,
  key: "securities:1|isin:IE00B03HD191",
  kind: "fund",
  linked: false,
  members: [],
  name: "Fondo",
  operations: 31,
  otherHolder: false,
  rung: "invested",
  selectedByDefault: true,
  since: "2024-03-18",
  units: "24.85",
  valueMinor: 106_473,
  withheldMinor: null,
};

const euros = (minor: number) => `${minor / 100} €`;

describe("the words of the first start (#1880)", () => {
  test("the history a product brings, as the design writes it", () => {
    expect(myInvestorSinceLabel("2024-03-18")).toBe("mar 2024");
    expect(myInvestorHistoryLine(ROW)).toBe("31 operaciones desde mar 2024");
    expect(myInvestorHistoryLine({ ...ROW, operations: 1 })).toBe(
      "1 operación desde mar 2024",
    );
    expect(myInvestorHistoryLine({ ...ROW, kind: "cash" })).toBe(
      "Saldo de hoy, sin movimientos",
    );
  });

  test("each note says what another slice still has to do", () => {
    expect(myInvestorRowNotes({ ...ROW, withheldMinor: 14_923 }, euros)).toEqual([
      "149.23 € retenidos por órdenes en curso, ya dentro del saldo",
    ]);
    expect(
      myInvestorRowNotes({ ...ROW, inheritedCostPending: true }, euros)[0],
    ).toContain("te preguntaremos lo que costó");
    expect(
      myInvestorRowNotes(
        { ...ROW, block: { holdingName: "Fondo (a mano)", reason: "manual_twin" } },
        euros,
      )[0],
    ).toContain("«Fondo (a mano)»");
    expect(
      myInvestorRowNotes(
        { ...ROW, block: { reason: "managed_portfolio" }, members: ["Oro", "Plata"] },
        euros,
      )[0],
    ).toContain("Oro · Plata");
  });

  test("the row's state: read, choose, then whether the last read is today's", () => {
    const base = {
      hasDiscovery: false,
      lastSyncAt: null,
      linkedCount: 0,
      today: "2026-11-04",
    };
    expect(myInvestorRowState(base).label).toBe("Falta leer tus productos");
    expect(myInvestorRowState({ ...base, hasDiscovery: true }).label).toBe(
      "Falta elegir qué incluir",
    );
    expect(
      myInvestorRowState({
        ...base,
        hasDiscovery: true,
        lastSyncAt: "2026-11-04T09:00:00.000Z",
        linkedCount: 3,
      }).label,
    ).toBe("Al día");
    expect(
      myInvestorRowState({
        ...base,
        hasDiscovery: true,
        lastSyncAt: "2026-11-01T09:00:00.000Z",
        linkedCount: 3,
      }).label,
    ).toBe("Desactualizado");
  });
});

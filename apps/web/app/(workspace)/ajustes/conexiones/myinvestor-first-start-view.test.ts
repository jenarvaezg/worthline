import type { MyInvestorCareo } from "@web/ajustes/myinvestor-careo";
import type {
  MyInvestorProductRow,
  MyInvestorTwin,
} from "@web/ajustes/myinvestor-selection";
import { describe, expect, test } from "vitest";

import {
  myInvestorCareoRowCells,
  myInvestorCareoVerdict,
  myInvestorHistoryLine,
  myInvestorPlanSentence,
  myInvestorPortfolioCashLine,
  myInvestorPortfolioComposition,
  myInvestorPortfolioMemberHead,
  myInvestorPortfolioMembersLine,
  myInvestorPortfolioTwinOptions,
  myInvestorPortfolioWitnessLine,
  myInvestorRowNotes,
  myInvestorRowState,
  myInvestorSinceLabel,
  myInvestorTwinLegend,
  myInvestorTwinOptions,
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
  portfolio: null,
  portfolioTwin: null,
  rung: "invested",
  selectedByDefault: true,
  since: "2024-03-18",
  twin: null,
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

describe("the careo of a twin, in words (#1881, design C)", () => {
  const careo: MyInvestorCareo = {
    after: { averageMinor: 3_618, costMinor: 45_268, units: "12.5111" },
    before: { averageMinor: 3_569, costMinor: 40_254, units: "11.2791" },
    counts: { enters: 2, leaves: 2, manual: 3, same: 1 },
    plan: {
      lines: [
        {
          amount: { mode: "money", value: 10_037 },
          cadence: { dayOfMonth: 5, kind: "monthly" },
        },
      ],
      pending: 0,
    },
    rows: [
      {
        amountMinor: 25_107,
        date: "2024-09-05",
        kind: "buy",
        mark: "enters",
        near: "2024-09-06",
        units: "6.9413",
      },
    ],
    valueDeltaMinor: 5_014,
  };
  const twin: MyInvestorTwin = {
    candidates: [{ assetId: "hand", careo, name: "Global (a mano)", pairedWith: [] }],
    defaultChoice: "link:hand",
    reason: "identifier",
    scheme: "isin",
  };

  test("the verdict is one sentence with the figures before and after", () => {
    expect(myInvestorCareoVerdict(careo, euros)).toBe(
      "Coinciden 1 de 3 operaciones tuyas. Se van 2 tuyas y entran 2 de MyInvestor. " +
        "Participaciones 11,2791 → 12,5111; coste 402.54 € → 452.68 €; " +
        "coste medio 35.69 € → 36.18 €. " +
        "Tu plan de 100.37 € el día 5 de cada mes se cierra hoy.",
    );
  });

  test("the plan sentence names what leaves the pending list", () => {
    expect(
      myInvestorPlanSentence(
        {
          lines: [
            { amount: { mode: "money", value: 5_013 }, cadence: { kind: "quarterly" } },
          ],
          pending: 2,
        },
        euros,
      ),
    ).toBe(
      "Tu plan de 50.13 € cada trimestre se cierra hoy y sus 2 aportaciones pendientes se dan por cerradas.",
    );
  });

  test("the legend says why it is a twin; the options are the three ways out", () => {
    expect(myInvestorTwinLegend(twin)).toBe(
      "Ya lo tienes a mano con el mismo ISIN en «Global (a mano)».",
    );
    expect(myInvestorTwinLegend({ ...twin, reason: "name", scheme: "dgs" })).toBe(
      "Se parece por el nombre a «Global (a mano)», que no tiene código DGS. ¿Es el mismo?",
    );
    expect(myInvestorTwinOptions(twin).map((option) => option.value)).toEqual([
      "link:hand",
      "separate",
      "skip",
    ]);
  });

  test("a row of the operations carries the near-day hint, never a pairing", () => {
    expect(myInvestorCareoRowCells(careo.rows[0]!, euros)).toEqual({
      amount: "251.07 €",
      date: "5 sep 2024",
      hint: "igual que la del 6 sep 2024: revisa la fecha",
      kind: "Compra",
      mark: "+ entra",
      units: "6,9413",
    });
  });
});

describe("a robo-advisor's block, in words (#1883)", () => {
  const block: MyInvestorProductRow = {
    ...ROW,
    identifier: null,
    key: "portfolio:9",
    kind: "managed",
    name: "Cartera sintética",
    portfolio: {
      cash: {
        identifier: "ES00 ···0000",
        key: "cash:7",
        name: "Cuenta",
        valueMinor: 734,
      },
      declaredMinor: 61_237,
      joins: null,
      looseTwins: [],
      members: [
        {
          identifier: "IE0000000001",
          key: "a",
          name: "Oro",
          operations: 3,
          soldByManager: false,
          units: "4.1",
          valueMinor: 30_011,
        },
        {
          identifier: "IE0000000002",
          key: "b",
          name: "Plata",
          operations: 2,
          soldByManager: false,
          units: "2.9",
          valueMinor: 31_013,
        },
        {
          identifier: "IE0000000003",
          key: "c",
          name: "Cobre",
          operations: 2,
          soldByManager: true,
          units: "0",
          valueMinor: 0,
        },
      ],
    },
  };

  test("one row: its funds today, its cash, and the funds the manager sold", () => {
    expect(myInvestorPortfolioComposition(block)).toBe("2 fondos + efectivo");
    expect(myInvestorPortfolioMembersLine(block)).toBe(
      "Oro · Plata · Cuenta (efectivo). Y 1 fondo que el gestor ya vendió, a 0 con su historial",
    );
    expect(myInvestorPortfolioWitnessLine(block, euros)).toContain(
      "MyInvestor declara 612.37 € en fondos, sin el efectivo",
    );
    expect(myInvestorPortfolioComposition(ROW)).toBeNull();
  });

  const blocked = {
    blockers: ["Bronce (a mano)"],
    cash: { afterMinor: 734, assetId: "box", beforeMinor: 517, name: "Efectivo Metal" },
    href: "/patrimonio/carteras/wl_prt_1",
    members: [],
    name: "Metal",
    portfolioId: "p1",
    strandedTransfers: [],
    valueDeltaMinor: 217,
  };

  test("a manual member MyInvestor lacks disables «Enlazar», with its reason and remedy", () => {
    const [link, apart, skip] = myInvestorPortfolioTwinOptions({
      candidates: [blocked],
      defaultChoice: "skip",
    });
    expect(link).toMatchObject({
      disabled: true,
      href: "/patrimonio/carteras/wl_prt_1",
      label:
        "Enlazar con la cartera «Metal»: MyInvestor sustituye sus fondos y su efectivo",
      note: "No se puede enlazar: «Bronce (a mano)» está en tu cartera y MyInvestor no lo tiene en esta cuenta. Sácalo de la cartera o envíalo a la papelera, y vuelve aquí.",
    });
    expect(apart!.disabled).toBe(false);
    expect(skip!.value).toBe("skip");
  });

  test("each fund says what it replaces, and the cash its balance before and after", () => {
    expect(
      myInvestorPortfolioMemberHead(
        {
          assetId: null,
          assetName: null,
          careo: null,
          enteringMinor: 31_013,
          name: "Plata",
          productKey: "b",
        },
        euros,
      ),
    ).toBe("«Plata» entra nuevo en la cartera: 310.13 €.");
    expect(
      myInvestorPortfolioMemberHead(
        {
          assetId: "h",
          assetName: "Oro (a mano)",
          careo: null,
          enteringMinor: 0,
          name: "Oro",
          productKey: "a",
        },
        euros,
      ),
    ).toBe("«Oro (a mano)» ← «Oro»:");
    expect(myInvestorPortfolioCashLine(blocked, euros)).toBe(
      "Efectivo «Efectivo Metal»: 5.17 € → 7.34 €, el saldo de MyInvestor.",
    );
  });
});

import type { AssetClassReturnsViewResult } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import ReturnsByClassSection from "./returns-by-class-section";

/**
 * Render/wiring test for the /patrimonio per-asset-class returns section (#552).
 * It asserts each class row renders its Spanish label, value, and the three
 * measures (with an em dash for an un-computable one), that the two-way coverage
 * (clasificado / sin clasificar) is shown, and that the honest attribution caveat
 * is present, never buried.
 */

const EUR = "EUR";

function marketView(overrides: {
  totalReturnRatio: number | null;
  irrRate: number | null;
  twrRate: number | null;
}): AssetClassReturnsViewResult["classes"][number]["view"] {
  return {
    annualized: true,
    caveats: ["No incluye dividendos ni cupones."],
    costBasisGrade: null,
    cagr: 0.1,
    irr: {
      rate: overrides.irrRate,
      reason: overrides.irrRate === null ? "single_sign" : null,
    },
    kind: "market",
    realizedPnl: null,
    totalGain: { amountMinor: 30_000, currency: EUR },
    totalReturnRatio: overrides.totalReturnRatio,
    twr: {
      annualized: false,
      annualizedRate: null,
      endDate: "2026-01-01",
      rate: overrides.twrRate,
      reason: overrides.twrRate === null ? "insufficient_monthly_closes" : null,
      spanDays: 200,
      startDate: "2025-06-01",
    },
    unrealizedPnl: null,
  };
}

const result: AssetClassReturnsViewResult = {
  classes: [
    {
      attributedOnly: false,
      closed: false,
      key: "equity",
      value: { amountMinor: 150_000, currency: EUR },
      view: marketView({ irrRate: 0.082, totalReturnRatio: 0.5, twrRate: 0.071 }),
    },
    {
      attributedOnly: false,
      closed: false,
      key: "unclassified",
      value: { amountMinor: 40_000, currency: EUR },
      view: marketView({ irrRate: null, totalReturnRatio: 0.1, twrRate: null }),
    },
  ],
  coverage: {
    classified: { amountMinor: 150_000, currency: EUR },
    notApplicable: { amountMinor: 0, currency: EUR },
    unknown: { amountMinor: 40_000, currency: EUR },
  },
};

describe("ReturnsByClassSection", () => {
  test("renders each class's label, measures and the coverage + caveat", () => {
    const html = renderToStaticMarkup(
      <ReturnsByClassSection privacyMode={false} returns={result} />,
    );

    expect(html).toContain("Renta variable");
    expect(html).toContain("Sin clasificar");
    // equity gain +50% and IRR/TWR present.
    expect(html).toContain("+50,0 %");
    expect(html).toContain("+8,2 %");
    expect(html).toContain("+7,1 %");
    // unclassified IRR/TWR are un-computable → em dash, never fabricated.
    expect(html).toContain("—");
    // Honest caveat surfaced.
    expect(html).toContain("no históricos");
  });

  test("masks money under privacy mode but still shows the percentages", () => {
    const html = renderToStaticMarkup(
      <ReturnsByClassSection privacyMode returns={result} />,
    );

    // 150_000 minor → "1.500 €" is masked to "*" digits; the percentages stay.
    expect(html).not.toContain("1.500");
    expect(html).toContain("+50,0 %");
  });
});

describe("una TWR ausente dice por qué (#1457)", () => {
  test("el guion de la clase lleva el motivo al pasar por encima", () => {
    const html = renderToStaticMarkup(
      <ReturnsByClassSection
        privacyMode={false}
        returns={{
          classes: [
            {
              attributedOnly: false,
              closed: false,
              key: "commodity",
              value: { amountMinor: 99_900, currency: EUR },
              view: {
                ...marketView({ irrRate: 0.05, totalReturnRatio: 0.1, twrRate: null }),
                twr: {
                  annualized: false,
                  annualizedRate: null,
                  endDate: "2025-12-10",
                  rate: null,
                  reason: "non_measurable_subperiod",
                  spanDays: 12,
                  startDate: "2025-11-28",
                },
              },
            },
          ],
          coverage: {
            classified: { amountMinor: 99_900, currency: EUR },
            notApplicable: { amountMinor: 0, currency: EUR },
            unknown: { amountMinor: 0, currency: EUR },
          },
        }}
      />,
    );

    expect(html).toContain(
      "Sin TWR: un tramo con más movimiento que valor no es medible.",
    );
  });
});

describe("una clase cerrada no compite con las vivas (#1456)", () => {
  const withClosed: AssetClassReturnsViewResult = {
    classes: [
      ...result.classes,
      {
        attributedOnly: false,
        closed: true,
        key: "crypto",
        value: { amountMinor: 0, currency: EUR },
        view: marketView({ irrRate: -0.971, totalReturnRatio: -0.075, twrRate: null }),
      },
    ],
    coverage: result.coverage,
  };

  test("la clase a cero se repliega tras su propio control, y las vivas quedan en la lista", () => {
    const html = renderToStaticMarkup(
      <ReturnsByClassSection privacyMode={false} returns={withClosed} />,
    );

    // La lista viva llega hasta las clases con valor; la cerrada vive en el fold.
    const [liveHtml, foldHtml] = html.split("<details");
    expect(liveHtml).toContain("Renta variable");
    expect(liveHtml).not.toContain("Cripto");
    expect(foldHtml).toContain("Cripto");
    expect(html).toContain("Clases cerradas (1)");
    // Sigue siendo consultable: el −97,1 % está, replegado, no borrado.
    expect(foldHtml).toContain("−97,1 %");
  });

  test("el pie de cobertura es el mismo con y sin la fila a cero", () => {
    const footer = (returns: AssetClassReturnsViewResult): string =>
      renderToStaticMarkup(
        <ReturnsByClassSection privacyMode={false} returns={returns} />,
      )
        .split('<dl class="exposureCoverage">')[1]!
        .split("</dl>")[0]!;

    expect(footer(withClosed)).toBe(footer(result));
  });

  test("una clase en pérdidas pero con valor sigue en la lista viva", () => {
    // Perder dinero no repliega una clase; tener cero sí. Sin este guard, la
    // regla podría leerse como «esconde lo que va mal».
    const losing: AssetClassReturnsViewResult = {
      classes: [
        {
          attributedOnly: false,
          closed: false,
          key: "commodity",
          value: { amountMinor: 40_000, currency: EUR },
          view: marketView({ irrRate: -0.31, totalReturnRatio: -0.6, twrRate: -0.28 }),
        },
      ],
      coverage: result.coverage,
    };

    const html = renderToStaticMarkup(
      <ReturnsByClassSection privacyMode={false} returns={losing} />,
    );

    expect(html.split("<details")[0]).toContain("Materias primas");
    expect(html).toContain("−60,0 %");
    expect(html).not.toContain("Clases cerradas");
  });

  test("un workspace con todo liquidado lo dice, en vez de dejar la lista muda", () => {
    const html = renderToStaticMarkup(
      <ReturnsByClassSection
        privacyMode={false}
        returns={{
          classes: withClosed.classes.filter((entry) => entry.closed),
          coverage: {
            classified: { amountMinor: 0, currency: EUR },
            notApplicable: { amountMinor: 0, currency: EUR },
            unknown: { amountMinor: 0, currency: EUR },
          },
        }}
      />,
    );

    expect(html).toContain("Ninguna clase con valor hoy.");
    expect(html).toContain("Clases cerradas (1)");
  });

  test("sin clases cerradas la sección se ve exactamente igual que antes", () => {
    const html = renderToStaticMarkup(
      <ReturnsByClassSection privacyMode={false} returns={result} />,
    );

    expect(html).not.toContain("<details");
    expect(html).not.toContain("Clases cerradas");
  });
});

describe("una clase sin producto propio no promete medición (#1458)", () => {
  // El caso real: 1.312 € de «efectivo» que son la manga de tesorería de dos
  // planes mixtos, presentados con un +10,4% que era el de los planes.
  const borrowed: AssetClassReturnsViewResult = {
    classes: [
      result.classes[0]!,
      {
        attributedOnly: true,
        closed: false,
        key: "cash",
        value: { amountMinor: 131_200, currency: EUR },
        view: {
          ...marketView({ irrRate: null, totalReturnRatio: null, twrRate: null }),
          cagr: null,
          irr: null,
          twr: null,
        },
      },
    ],
    coverage: result.coverage,
  };

  const html = (): string =>
    renderToStaticMarkup(
      <ReturnsByClassSection privacyMode={false} returns={borrowed} />,
    );

  test("la fila lleva su marca y explica en el pie qué significa", () => {
    expect(html()).toContain("atribuida");
    expect(html()).toContain("Ni un euro de esta clase está en un producto suyo");
  });

  test("la fila prestada no imprime ninguna de las tres tasas", () => {
    const row = html().split('<li class="returnsClassRow"')[2]!.split("</li>")[0]!;
    const measures = row.split('<dl class="returnsClassMeasures">')[1]!;

    expect(row).toContain("Efectivo");
    expect(measures).not.toContain(" %");
    expect(measures.match(/—/g)).toHaveLength(3);
    // Valor y peso sobreviven: el reparto de euros sí se sabe.
    expect(row.split("<dl")[0]).toContain("<b>1312");
  });

  test("el guion de una clase prestada dice ese motivo, no el de una TWR corta", () => {
    const row = html().split('<li class="returnsClassRow"')[2]!.split("</li>")[0]!;

    expect(row).not.toContain("Sin TWR");
    expect(row).toContain("fracción de productos mixtos");
  });

  test("la sección solo cambia de titular; la clase con producto propio sigue igual", () => {
    const measuredRow = html().split('<li class="returnsClassRow"')[1]!;

    expect(measuredRow).toContain("+50,0 %");
    expect(measuredRow).not.toContain("atribuida");
  });

  test("sin ninguna clase prestada, ni la marca ni su nota aparecen", () => {
    const plain = renderToStaticMarkup(
      <ReturnsByClassSection privacyMode={false} returns={result} />,
    );

    expect(plain).not.toContain("atribuida");
    expect(plain).not.toContain("producto suyo");
  });
});

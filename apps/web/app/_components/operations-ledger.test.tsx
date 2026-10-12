import type { InvestmentOperation } from "@worthline/domain";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { OperationsBookProvider } from "./operations-book";
import { OperationsLedger } from "./operations-ledger";

const noop = async () => {};

function render(
  operations: readonly InvestmentOperation[] = [],
  overrides: Partial<ComponentProps<typeof OperationsLedger>> = {},
) {
  return renderToStaticMarkup(
    <OperationsBookProvider operations={operations}>
      <OperationsLedger
        currentUrl="/patrimonio/wl_hld_1/editar"
        deleteAction={noop}
        {...overrides}
      />
    </OperationsBookProvider>,
  );
}

/** The USD apunte of #1401, as the ledger holds it after conversion. */
const convertedUsdBuy: InvestmentOperation = {
  assetId: "asset_1",
  capture: {
    currency: "USD",
    eurPerUnit: 0.85,
    feesMinor: 0,
    pricePerUnit: "8.00",
  },
  currency: "EUR",
  executedAt: "2026-01-23",
  feesMinor: 0,
  id: "op_usd",
  kind: "buy",
  pricePerUnit: "6.8",
  units: "0.255",
};

describe("an empty ledger says so", () => {
  test("no operations, one line instead of an empty table", () => {
    const html = render();

    expect(html).toContain("Todavía no hay operaciones.");
    expect(html).not.toContain("<table");
    // The anchor `?abrir=operaciones#operaciones` lands on is there either way.
    expect(html).toContain('id="operaciones"');
  });
});

describe("currency at the capture (#1401)", () => {
  test("a converted row shows the euros it folded and the dollars it came from", () => {
    const html = render([convertedUsdBuy]);

    expect(html).toContain("6,8");
    expect(html).toContain("8 USD");
  });

  test("an optimistic row still in its own currency is not read as euros", () => {
    const { capture: _capture, ...typed } = convertedUsdBuy;
    const html = render([{ ...typed, currency: "USD", pricePerUnit: "8,00" }]);

    expect(html).toContain("8,00 USD");
  });
});

const jorgeRow: InvestmentOperation = {
  assetId: "asset_1",
  currency: "EUR",
  executedAt: "2026-08-19",
  feesMinor: 0,
  id: "op_jorge",
  kind: "buy",
  pricePerUnit: "52.09166666666666667",
  units: "6",
};

describe("operation rows are readable (#1467)", () => {
  test("date, units and a 20-dp leftover render in es-ES without migrating the row", () => {
    const html = render([jorgeRow]);

    expect(html).toContain("19/08/2026");
    expect(html).not.toContain(">2026-08-19<");
    expect(html).toContain("52,09166667");
    expect(html).not.toContain("52.09166666666666667");
    expect(html).toContain(">6<");
  });

  test("a fractional quantity uses the es-ES comma", () => {
    const html = render([{ ...jorgeRow, units: "7.226" }]);

    expect(html).toContain("7,226");
    expect(html).not.toContain(">7.226<");
  });

  test("privacy mode still masks the formatted price", () => {
    const html = render([jorgeRow], { privacyMode: true });

    expect(html).toContain("**,********");
    expect(html).not.toContain("52,09166667");
    expect(html).toContain("19/08/2026");
  });

  test("each delete posts the operation and returns to the ficha", () => {
    const html = render([jorgeRow]);

    expect(html).toContain('value="op_jorge"');
    expect(html).toContain('value="/patrimonio/wl_hld_1/editar"');
  });
});

/** The markup with Intl's no-break spaces read as plain ones. */
const plain = (html: string) => html.replace(/[  ]/g, " ");

/** `count` buys, one a day back from 2026-09-30, newest first by date. */
function buys(count: number): InvestmentOperation[] {
  return Array.from({ length: count }, (_, index) => ({
    assetId: "asset_1",
    currency: "EUR",
    executedAt: `2026-09-${String(30 - index).padStart(2, "0")}`,
    feesMinor: 0,
    id: `op_${index + 1}`,
    kind: "buy" as const,
    pricePerUnit: "100",
    units: "1",
  }));
}

describe("el libro compacto (#1827)", () => {
  const purchase: InvestmentOperation = {
    assetId: "asset_1",
    currency: "EUR",
    executedAt: "2026-09-12",
    feesMinor: 100,
    id: "op_buy",
    kind: "buy",
    pricePerUnit: "106.65",
    units: "5",
  };

  test("las columnas son Fecha, Tipo, Participaciones, Precio, Comisión e Importe", () => {
    const html = render([purchase]);

    for (const header of [
      "Fecha",
      "Tipo",
      "Participaciones",
      "Precio",
      "Comisión",
      "Importe",
    ]) {
      expect(html).toContain(`>${header}</th>`);
    }
  });

  test("cada fila trae su importe, el del dominio, con sus céntimos", () => {
    expect(plain(render([purchase]))).toContain("534,25 €");
  });

  test("en el teléfono la fila se lee en dos renglones, sin tabla que desplazar", () => {
    const html = plain(render([purchase]));

    expect(html).toContain("5 × 106,65 € · comisión 1 €");
    expect(html).not.toContain("tableScroll");
  });

  test("«Eliminar» vive dentro de «⋯» y sigue pidiendo confirmación", () => {
    const html = render([purchase]);
    const menu = html.slice(
      html.indexOf('aria-label="Acciones de la operación del 12/09/2026"'),
    );

    expect(html).toContain('aria-label="Acciones de la operación del 12/09/2026"');
    expect(menu).toContain('class="confirmDelete"');
    expect(menu).toContain("<summary>Eliminar</summary>");
    expect(menu).toContain(">Confirmar</button>");
  });

  test("con diez o menos no hay nada que desplegar", () => {
    const html = render(buys(10));

    expect(html.match(/<tr[ >]/g)).toHaveLength(11);
    expect(html).not.toContain("Ver las");
  });

  test("con más de diez se ven las diez últimas y «Ver las N operaciones»", () => {
    const html = render(buys(12));

    // The header row plus ten.
    expect(html.match(/<tr[ >]/g)).toHaveLength(11);
    expect(html).toContain("30/09/2026");
    expect(html).not.toContain("19/09/2026");
    expect(html).toMatch(/aria-expanded="false"[^>]*>Ver las 12 operaciones</);
  });

  test("la fila recién registrada se marca, y se ve aunque caiga más allá de la décima (#1829)", () => {
    const html = render(buys(12), { freshIds: new Set(["op_12"]) });

    expect(html).toContain("19/09/2026");
    expect(html.match(/data-fresh=""/g)).toHaveLength(1);
    expect(html).toContain('<small class="fichaFreshMark">nueva</small>');
  });
});

describe("el par de traspaso se lee como un movimiento, no como compraventa (#1481)", () => {
  const transferOut: InvestmentOperation = {
    assetId: "asset_1",
    currency: "EUR",
    executedAt: "2026-08-12",
    feesMinor: 0,
    id: "op_out",
    kind: "transfer_out",
    pricePerUnit: "150",
    transferId: "trf_1",
    units: "5",
  };
  const transferIn: InvestmentOperation = {
    assetId: "asset_1",
    currency: "EUR",
    executedAt: "2026-08-12",
    feesMinor: 0,
    id: "op_in",
    kind: "transfer_in",
    pricePerUnit: "150",
    transferCostMinor: 97_718,
    transferId: "trf_1",
    units: "5",
  };

  test("la salida nombra su destino en la fila", () => {
    const html = render([transferOut], {
      transferCounterparts: { op_out: { kind: "holding", name: "Fondo Azul" } },
    });

    expect(html).toContain("Traspaso (salida)");
    expect(html).toContain("a Fondo Azul");
  });

  test("un traspaso es UNA entrada del libro, nunca una venta o compra sueltas", () => {
    const html = render([transferOut], {
      transferCounterparts: { op_out: { kind: "holding", name: "Fondo Azul" } },
    });

    expect(html.match(/Traspaso \(/g)).toHaveLength(1);
    expect(html).not.toContain("<td>Venta</td>");
    expect(html).not.toContain("<td>Compra</td>");
  });

  test("la entrada nombra su origen y enseña el coste heredado, céntimo a céntimo", () => {
    const html = render([transferIn], {
      transferCounterparts: { op_in: { kind: "holding", name: "Fondo Rojo" } },
    });

    expect(html).toContain("Traspaso (entrada)");
    expect(html).toContain("desde Fondo Rojo");
    expect(html).toContain("coste heredado 977,18");
  });

  test("la media pareja externa dice «desde otra entidad»", () => {
    const html = render([{ ...transferIn, id: "op_ext", transferId: "trf_ext" }], {
      transferCounterparts: { op_ext: { kind: "external" } },
    });

    expect(html).toContain("desde otra entidad");
  });

  test("sin mapa de contrapartes la fila no afirma un destino", () => {
    const html = render([transferOut]);

    expect(html).toContain("Traspaso (salida)");
    expect(html).not.toContain("otra entidad");
  });

  test("eliminar media fila avisa de que se lleva el traspaso entero", () => {
    const html = render([transferOut], {
      transferCounterparts: { op_out: { kind: "holding", name: "Fondo Azul" } },
    });

    expect(html).toContain("las dos mitades");
  });

  test("una compra ni lleva nota de traspaso ni avisa de pares", () => {
    const html = render([
      {
        assetId: "asset_1",
        currency: "EUR",
        executedAt: "2026-08-12",
        feesMinor: 0,
        id: "op_buy",
        kind: "buy",
        pricePerUnit: "150",
        units: "5",
      },
    ]);

    expect(html).toContain("Compra");
    expect(html).not.toContain("las dos mitades");
    expect(html).not.toContain("coste heredado");
  });
});

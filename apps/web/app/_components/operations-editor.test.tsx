import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import OperationsEditor, { RecordOperationSubmit } from "./operations-editor";

const noop = async () => {};

function render(
  context: React.ComponentProps<typeof OperationsEditor>["context"] = {},
  overrides: Partial<React.ComponentProps<typeof OperationsEditor>> = {},
) {
  return renderToStaticMarkup(
    <OperationsEditor
      assetId="asset_1"
      assetName="Fondo Indexado"
      context={context}
      currentUrl="/patrimonio/asset_1/editar"
      deleteAction={noop}
      formError={null}
      operations={[]}
      recordAction={noop}
      today="2026-06-25"
      {...overrides}
    />,
  );
}

describe("OperationsEditor required/optional convention (#603)", () => {
  test("required fields show no orphan asterisk", () => {
    expect(render()).not.toMatch(/>\*</);
  });

  test("optional field (comisiones) is marked '(opcional)'", () => {
    expect(render()).toContain("(opcional)");
  });

  test("required fields keep their accessible required semantics", () => {
    // Visual asterisk goes, but units/price are still genuinely required.
    expect(render()).toContain('aria-required="true"');
  });
});

describe("price context when the provider fetch failed (#1330)", () => {
  test("a failed price shows the failure, not a zero price", () => {
    const html = render({
      currentUnits: "10",
      priceFreshness: "failed",
      priceRefreshCaption: "Precio actualizado el 7 jul 2026 · Yahoo",
    });

    expect(html).toContain("Último precio");
    expect(html).toContain("Sin precio");
    expect(html).toContain("Fallido");
  });

  test("a known price is still shown with its freshness chip", () => {
    const html = render({
      currentUnits: "10",
      priceFreshness: "fresh",
      unitPrice: "130.5",
    });

    expect(html).toContain("130.5");
    expect(html).toContain("Reciente");
    expect(html).not.toContain("Sin precio");
  });
});

describe("double-submit guard on the record button (#1394)", () => {
  test("the idle button is enabled and reads 'Registrar operación'", () => {
    const html = renderToStaticMarkup(<RecordOperationSubmit pending={false} />);

    expect(html).toContain("Registrar operación");
    expect(html).not.toContain("disabled");
  });

  test("while the action is in flight the button is disabled", () => {
    // The second of two clicks never reaches the server: this is what stopped a
    // sell from being recorded twice and eating ~1.000 € of net worth.
    const html = renderToStaticMarkup(<RecordOperationSubmit pending={true} />);

    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Registrando…");
  });

  test("the editor renders the record button in its idle state", () => {
    expect(render()).toContain("Registrar operación");
  });
});

/** The USD apunte of #1401, as the ledger holds it after conversion. */
const convertedUsdBuy = {
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
  kind: "buy" as const,
  pricePerUnit: "6.8",
  units: "0.255",
};

describe("currency at the capture (#1401)", () => {
  test("the money fields are labelled EUR by default, as before", () => {
    const html = render();

    expect(html).toContain("Precio por unidad (EUR)");
    expect(html).toContain("Comisiones (EUR)");
    // Nothing to warn about: a euro apunte is not converted.
    expect(html).not.toContain("tipo del BCE");
  });

  test("the picker starts on the currency the holding last captured", () => {
    const html = render({}, { defaultCurrency: "USD" });

    expect(html).toContain("Precio por unidad (USD)");
    expect(html).toContain("Comisiones (USD)");
    // The server markup carries the selection, so the no-JS post sends USD too.
    expect(html).toContain('<option value="USD" selected="">');
    // Said before the submit, so the user knows WHICH day's rate applies.
    expect(html).toContain("tipo del BCE del día de la operación");
  });

  test("a rejected capture round-trips the currency instead of falling back to EUR", () => {
    const html = render(
      {},
      {
        formError: {
          formId: "operation",
          message: "No hay tipo de cambio del BCE de USD para el 23 ene 2026.",
          values: { currency: "USD", pricePerUnit: "8,00", units: "0,255" },
        },
      },
    );

    expect(html).toContain("Precio por unidad (USD)");
  });

  test("the engine's currency warning is rendered, as a refusal not a hint", () => {
    const html = render({
      currencyWarning:
        "Las operaciones de esta inversión están en USD, pero el coste se ha sumado como si fueran EUR.",
    });

    expect(html).toContain('class="errorBand"');
    expect(html).toContain("el coste se ha sumado como si fueran EUR");
  });

  test("no warning, no band", () => {
    expect(render()).not.toContain('role="alert"');
  });

  test("a converted row shows the euros it folded and the dollars it came from", () => {
    const html = render({}, { operations: [convertedUsdBuy] });

    expect(html).toContain("6,8");
    expect(html).toContain("8 USD");
  });

  test("an optimistic row still in its own currency is not read as euros", () => {
    const { capture: _capture, ...typed } = convertedUsdBuy;
    const html = render(
      {},
      { operations: [{ ...typed, currency: "USD", pricePerUnit: "8,00" }] },
    );

    expect(html).toContain("8,00 USD");
  });
});

const jorgeRow = {
  assetId: "asset_1",
  currency: "EUR",
  executedAt: "2026-08-19",
  feesMinor: 0,
  id: "op_jorge",
  kind: "buy" as const,
  pricePerUnit: "52.09166666666666667",
  units: "6",
};

describe("operation rows are readable (#1467)", () => {
  test("date, units and a 20-dp leftover render in es-ES without migrating the row", () => {
    const html = render({}, { operations: [jorgeRow] });

    expect(html).toContain("19/08/2026");
    expect(html).not.toContain(">2026-08-19<");
    expect(html).toContain("52,09166667");
    expect(html).not.toContain("52.09166666666666667");
    expect(html).toContain(">6<");
  });

  test("a fractional quantity uses the es-ES comma", () => {
    const html = render({}, { operations: [{ ...jorgeRow, units: "7.226" }] });

    expect(html).toContain("7,226");
    expect(html).not.toContain(">7.226<");
  });

  test("privacy mode still masks the formatted price", () => {
    const html = render({}, { operations: [jorgeRow], privacyMode: true });

    expect(html).toContain("**,********");
    expect(html).not.toContain("52,09166667");
    expect(html).toContain("19/08/2026");
  });
});

describe("el par de traspaso se lee como un movimiento, no como compraventa (#1481)", () => {
  const transferOut = {
    assetId: "asset_1",
    currency: "EUR",
    executedAt: "2026-08-12",
    feesMinor: 0,
    id: "op_out",
    kind: "transfer_out" as const,
    pricePerUnit: "150",
    transferId: "trf_1",
    units: "5",
  };
  const transferIn = {
    assetId: "asset_1",
    currency: "EUR",
    executedAt: "2026-08-12",
    feesMinor: 0,
    id: "op_in",
    kind: "transfer_in" as const,
    pricePerUnit: "150",
    transferCostMinor: 97_718,
    transferId: "trf_1",
    units: "5",
  };

  test("la salida nombra su destino en la fila", () => {
    const html = render(
      {},
      {
        operations: [transferOut],
        transferCounterparts: { op_out: { kind: "holding", name: "Fondo Azul" } },
      },
    );

    expect(html).toContain("Traspaso (salida)");
    expect(html).toContain("a Fondo Azul");
  });

  test("un traspaso es UNA entrada del libro, nunca una venta o compra sueltas", () => {
    const html = render(
      {},
      {
        operations: [transferOut],
        transferCounterparts: { op_out: { kind: "holding", name: "Fondo Azul" } },
      },
    );

    // Una sola fila de traspaso en el libro del origen — y ninguna celda de tipo
    // que la disfrace de compraventa (las palabras existen solo como opciones del
    // formulario de registrar, nunca como el tipo de esta fila).
    expect(html.match(/Traspaso \(/g)).toHaveLength(1);
    expect(html).not.toContain("<td>Venta</td>");
    expect(html).not.toContain("<td>Compra</td>");
  });

  test("la entrada nombra su origen y enseña el coste heredado, céntimo a céntimo", () => {
    const html = render(
      {},
      {
        operations: [transferIn],
        transferCounterparts: { op_in: { kind: "holding", name: "Fondo Rojo" } },
      },
    );

    expect(html).toContain("Traspaso (entrada)");
    expect(html).toContain("desde Fondo Rojo");
    expect(html).toContain("coste heredado 977,18");
  });

  test("la media pareja externa dice «desde otra entidad»", () => {
    const html = render(
      {},
      {
        operations: [{ ...transferIn, id: "op_ext", transferId: "trf_ext" }],
        transferCounterparts: { op_ext: { kind: "external" } },
      },
    );

    expect(html).toContain("desde otra entidad");
  });

  test("sin mapa de contrapartes la fila no afirma un destino", () => {
    const html = render({}, { operations: [transferOut] });

    expect(html).toContain("Traspaso (salida)");
    expect(html).not.toContain("otra entidad");
  });

  test("eliminar media fila avisa de que se lleva el traspaso entero", () => {
    const html = render(
      {},
      {
        operations: [transferOut],
        transferCounterparts: { op_out: { kind: "holding", name: "Fondo Azul" } },
      },
    );

    expect(html).toContain("las dos mitades");
  });

  test("una compra ni lleva nota de traspaso ni avisa de pares", () => {
    const html = render(
      {},
      {
        operations: [
          {
            assetId: "asset_1",
            currency: "EUR",
            executedAt: "2026-08-12",
            feesMinor: 0,
            id: "op_buy",
            kind: "buy" as const,
            pricePerUnit: "150",
            units: "5",
          },
        ],
      },
    );

    expect(html).toContain("Compra");
    expect(html).not.toContain("las dos mitades");
    expect(html).not.toContain("coste heredado");
  });
});

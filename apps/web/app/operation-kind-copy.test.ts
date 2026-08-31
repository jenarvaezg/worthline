import type { OperationKind } from "@worthline/domain";
import { formatMoneyMinorExact, maskMoneyString } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import { operationKindLabel, transferRowNote } from "./operation-kind-copy";

describe("operationKindLabel (#1393)", () => {
  test("cada mitad del traspaso se nombra por lo que es, no como compraventa", () => {
    expect(operationKindLabel("transfer_out")).toBe("Traspaso (salida)");
    expect(operationKindLabel("transfer_in")).toBe("Traspaso (entrada)");
  });

  test("la compra y la venta conservan su palabra de siempre", () => {
    expect(operationKindLabel("buy")).toBe("Compra");
    expect(operationKindLabel("sell")).toBe("Venta");
  });

  test("los cuatro tipos del libro tienen nombre", () => {
    const kinds: OperationKind[] = ["buy", "sell", "transfer_in", "transfer_out"];
    for (const kind of kinds) {
      expect(operationKindLabel(kind)).not.toBe("");
    }
  });
});

describe("transferRowNote (#1481)", () => {
  const cost = (amountMinor: number) =>
    formatMoneyMinorExact({ amountMinor, currency: "EUR" });

  test("la salida nombra su destino: el par es una operación, no una venta suelta", () => {
    expect(
      transferRowNote({
        counterpart: { kind: "holding", name: "Fondo Azul" },
        kind: "transfer_out",
        privacyMode: false,
      }),
    ).toBe("a Fondo Azul");
  });

  test("la entrada nombra su origen y enseña el coste heredado", () => {
    expect(
      transferRowNote({
        counterpart: { kind: "holding", name: "Fondo Rojo" },
        kind: "transfer_in",
        privacyMode: false,
        transferCostMinor: 97_718,
      }),
    ).toBe(`desde Fondo Rojo · coste heredado ${cost(97_718)}`);
  });

  test("la media pareja externa dice «otra entidad», no finge una contraparte", () => {
    expect(
      transferRowNote({
        counterpart: { kind: "external" },
        kind: "transfer_in",
        privacyMode: false,
        transferCostMinor: 9_546,
      }),
    ).toBe(`desde otra entidad · coste heredado ${cost(9_546)}`);
    expect(
      transferRowNote({
        counterpart: { kind: "external" },
        kind: "transfer_out",
        privacyMode: false,
      }),
    ).toBe("a otra entidad");
  });

  test("una contraparte irresoluble no afirma nada: solo queda el coste, si lo hay", () => {
    expect(
      transferRowNote({
        counterpart: { kind: "unresolved" },
        kind: "transfer_in",
        privacyMode: false,
        transferCostMinor: 9_546,
      }),
    ).toBe(`coste heredado ${cost(9_546)}`);
    expect(
      transferRowNote({
        counterpart: { kind: "unresolved" },
        kind: "transfer_out",
        privacyMode: false,
      }),
    ).toBeNull();
  });

  test("el modo privacidad enmascara el coste heredado, no lo omite", () => {
    expect(
      transferRowNote({
        counterpart: { kind: "holding", name: "Fondo Rojo" },
        kind: "transfer_in",
        privacyMode: true,
        transferCostMinor: 97_718,
      }),
    ).toBe(`desde Fondo Rojo · coste heredado ${maskMoneyString(cost(97_718))}`);
  });

  test("un transfer_in sin coste heredado (bug aguas arriba) no inventa una cifra", () => {
    expect(
      transferRowNote({
        counterpart: { kind: "holding", name: "Fondo Rojo" },
        kind: "transfer_in",
        privacyMode: false,
      }),
    ).toBe("desde Fondo Rojo");
  });

  test("la compra y la venta no llevan nota de traspaso", () => {
    for (const kind of ["buy", "sell"] as const) {
      expect(
        transferRowNote({
          counterpart: { kind: "unresolved" },
          kind,
          privacyMode: false,
        }),
      ).toBeNull();
    }
  });
});

describe("transferRowNote — la antigüedad heredada se puede LEER (#1518)", () => {
  test("una entrada externa con antigüedad la dice, junto a su coste heredado", () => {
    expect(
      transferRowNote({
        counterpart: { kind: "external" },
        kind: "transfer_in",
        privacyMode: false,
        transferCostMinor: 497_955,
        transferSeniorityAt: "2014-03-01",
      }),
    ).toBe(
      `desde otra entidad · coste heredado ${formatMoneyMinorExact({ amountMinor: 497_955, currency: "EUR" })} · antigüedad desde 01/03/2014`,
    );
  });

  test("sin antigüedad declarada la nota no la menciona", () => {
    // «Nadie lo ha dicho» es el estado de casi toda fila del libro: la nota no puede
    // insinuar una antigüedad que nadie declaró.
    expect(
      transferRowNote({
        counterpart: { kind: "external" },
        kind: "transfer_in",
        privacyMode: false,
        transferCostMinor: 497_955,
      }),
    ).toBe(
      `desde otra entidad · coste heredado ${formatMoneyMinorExact({ amountMinor: 497_955, currency: "EUR" })}`,
    );
  });

  test("el modo privado enmascara el coste pero NO la fecha", () => {
    // La antigüedad es una fecha, no dinero: enmascararla escondería el único dato
    // que hay que poder revisar, sin proteger ninguna cifra.
    const note = transferRowNote({
      counterpart: { kind: "external" },
      kind: "transfer_in",
      privacyMode: true,
      transferCostMinor: 497_955,
      transferSeniorityAt: "2014-03-01",
    });

    expect(note).toContain("antigüedad desde 01/03/2014");
    expect(note).not.toContain("4979");
  });

  test("la salida de un par nunca habla de antigüedad", () => {
    // La columna vive en la mitad que RECIBE. Una salida que la imprimiese estaría
    // leyendo un dato que su fila no puede tener.
    expect(
      transferRowNote({
        counterpart: { kind: "holding", name: "Fondo Azul" },
        kind: "transfer_out",
        privacyMode: false,
        transferSeniorityAt: "2014-03-01",
      }),
    ).toBe("a Fondo Azul");
  });
});

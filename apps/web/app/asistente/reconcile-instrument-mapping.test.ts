import { describe, expect, it } from "vitest";

import { mapReconcileTypeToInstrument } from "./reconcile-instrument-mapping";

describe("mapReconcileTypeToInstrument", () => {
  it("maps common es-ES labels to their instrument", () => {
    expect(mapReconcileTypeToInstrument("Fondo de inversión")).toBe("fund");
    expect(mapReconcileTypeToInstrument("ETF")).toBe("etf");
    expect(mapReconcileTypeToInstrument("Acciones")).toBe("stock");
    expect(mapReconcileTypeToInstrument("Plan de pensiones")).toBe("pension_plan");
    expect(mapReconcileTypeToInstrument("Cripto")).toBe("crypto");
    expect(mapReconcileTypeToInstrument("Cuenta corriente")).toBe("current_account");
    expect(mapReconcileTypeToInstrument("Hipoteca")).toBe("mortgage");
    expect(mapReconcileTypeToInstrument("Depósito a plazo")).toBe("term_deposit");
  });

  it("is diacritic- and case-insensitive", () => {
    expect(mapReconcileTypeToInstrument("  FONDO  ")).toBe("fund");
    expect(mapReconcileTypeToInstrument("índice")).toBe("index");
  });

  it("prefers the more specific keyword when one contains another", () => {
    // "plan de pensiones" must win over a bare "plan"; "fondo cotizado" is an ETF.
    expect(mapReconcileTypeToInstrument("Plan de pensiones individual")).toBe(
      "pension_plan",
    );
    expect(mapReconcileTypeToInstrument("Fondo cotizado (ETF)")).toBe("etf");
  });

  it("returns null for an unrecognized label rather than inventing a family", () => {
    expect(mapReconcileTypeToInstrument("no-lo-se-2000")).toBeNull();
    expect(mapReconcileTypeToInstrument("")).toBeNull();
    expect(mapReconcileTypeToInstrument("   ")).toBeNull();
  });
});

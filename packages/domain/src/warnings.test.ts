import { describe, expect, test } from "vitest";

import type { AssetType, ManualAsset } from "./index";
import { collectWarnings } from "./warnings";

function asset(
  id: string,
  name: string,
  amountMinor: number,
  type: AssetType = "cash",
  providerSymbol?: string,
  connectedSourceId?: string,
): ManualAsset {
  return {
    id,
    name,
    type,
    currentValue: { amountMinor, currency: "EUR" },
    ...(providerSymbol ? { providerSymbol } : {}),
    ...(connectedSourceId ? { connectedSourceId } : {}),
  } as ManualAsset;
}

describe("collectWarnings", () => {
  test("flags zero-value assets as overrideable", () => {
    const warnings = collectWarnings([
      asset("a1", "Cuenta", 0),
      asset("a2", "Piso", 100),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "ZERO_VALUE_ASSET",
      entityId: "a1",
      entityType: "asset",
      severity: "overrideable",
    });
  });

  test("does not flag a freshly-created derived holding at 0 (it reads 0 until its first operation)", () => {
    // Symbol'd so this fixture stays scoped to the zero-value exemption — its
    // provider-symbol state is covered separately below.
    const warnings = collectWarnings([
      asset("inv1", "ETF MSCI World", 0, "investment", "MSCI.FAKE"),
      asset("a1", "Cuenta", 0, "cash"),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "ZERO_VALUE_ASSET", entityId: "a1" });
  });

  test("suppresses an overrideable warning that has a matching override", () => {
    const warnings = collectWarnings(
      [asset("a1", "Cuenta", 0)],
      [{ code: "ZERO_VALUE_ASSET", entityId: "a1" }],
    );

    expect(warnings).toEqual([]);
  });

  test("an override for a different entity or code does not suppress the warning", () => {
    expect(
      collectWarnings(
        [asset("a1", "Cuenta", 0)],
        [{ code: "ZERO_VALUE_ASSET", entityId: "other" }],
      ),
    ).toHaveLength(1);
    expect(
      collectWarnings(
        [asset("a1", "Cuenta", 0)],
        [{ code: "OTHER_CODE", entityId: "a1" }],
      ),
    ).toHaveLength(1);
  });
});

describe("collectWarnings — MISSING_PROVIDER_SYMBOL (ADR 0055)", () => {
  test("flags a derived investment with no provider symbol as overrideable", () => {
    const warnings = collectWarnings([
      asset("inv1", "Fondo sin símbolo", 100_00, "investment"),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "MISSING_PROVIDER_SYMBOL",
      entityId: "inv1",
      entityType: "asset",
      severity: "overrideable",
    });
  });

  test("does not flag a derived investment that carries a provider symbol", () => {
    const warnings = collectWarnings([
      asset("inv1", "ETF MSCI World", 100_00, "investment", "MSCI.FAKE"),
    ]);

    expect(warnings).toEqual([]);
  });

  test("does not flag a non-derived (hand-valued) holding for a missing symbol", () => {
    const warnings = collectWarnings([asset("a1", "Cuenta", 100_00, "cash")]);

    expect(warnings).toEqual([]);
  });

  test("does not flag a symbol-less connected-source holding (Binance, Numista, …, #685 bug)", () => {
    const warnings = collectWarnings([
      asset("inv1", "Binance", 100_00, "investment", undefined, "source1"),
    ]);

    expect(warnings).toEqual([]);
  });

  test("suppresses the warning once overridden, for a hand-quoted fund", () => {
    const warnings = collectWarnings(
      [asset("inv1", "Fondo cotizado a mano", 100_00, "investment")],
      [{ code: "MISSING_PROVIDER_SYMBOL", entityId: "inv1" }],
    );

    expect(warnings).toEqual([]);
  });

  test("an override for a different entity or code does not suppress it", () => {
    expect(
      collectWarnings(
        [asset("inv1", "Fondo sin símbolo", 100_00, "investment")],
        [{ code: "MISSING_PROVIDER_SYMBOL", entityId: "other" }],
      ),
    ).toHaveLength(1);
    expect(
      collectWarnings(
        [asset("inv1", "Fondo sin símbolo", 100_00, "investment")],
        [{ code: "OTHER_CODE", entityId: "inv1" }],
      ),
    ).toHaveLength(1);
  });
});

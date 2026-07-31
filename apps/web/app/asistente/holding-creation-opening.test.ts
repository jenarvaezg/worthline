import { describe, expect, test } from "vitest";

import {
  openingCardBreakdown,
  resolveHoldingCreationOpening,
} from "./holding-creation-opening";

/**
 * The es-ES renderings the card is expected to produce, taken from Intl itself:
 * the space before the € sign is a narrow no-break one, never a plain space.
 */
const euros = (amountMinor: number): string =>
  new Intl.NumberFormat("es-ES", {
    currency: "EUR",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
const units = (value: string): string =>
  new Intl.NumberFormat("es-ES", { maximumFractionDigits: 6 }).format(Number(value));

/** The confirmation from the issue: 3 títulos × 54,545 € + 1,00 € = 164,64 €. */
const CONFIRMATION = {
  feesMinor: 1_00,
  openingValueMinor: 164_64,
  pricePerUnit: "54,545",
  units: "3",
};

describe("resolveHoldingCreationOpening (#1315) · declared units", () => {
  test("persists the declared units, price and commission verbatim", () => {
    const resolved = resolveHoldingCreationOpening(CONFIRMATION);

    expect(resolved).toEqual({
      ok: true,
      // Market value is units × price: the commission is cost basis, never value.
      opening: {
        feesMinor: 1_00,
        pricePerUnit: "54.545",
        units: "3",
        valueMinor: 163_64,
      },
    });
  });

  test("es-ES units are normalized, not rejected", () => {
    const resolved = resolveHoldingCreationOpening({
      pricePerUnit: "100",
      units: "3,5",
    });

    expect(resolved).toMatchObject({ ok: true, opening: { units: "3.5" } });
  });

  test("units without an amount need no reconciliation", () => {
    const resolved = resolveHoldingCreationOpening({
      pricePerUnit: "54,545",
      units: "3",
    });

    expect(resolved).toEqual({
      ok: true,
      opening: { pricePerUnit: "54.545", units: "3", valueMinor: 163_64 },
    });
  });

  test("a commission of 0 is «sin comisión» and carries nothing", () => {
    const resolved = resolveHoldingCreationOpening({
      feesMinor: 0,
      pricePerUnit: "100",
      units: "2",
    });

    expect(resolved).toEqual({
      ok: true,
      opening: { pricePerUnit: "100", units: "2", valueMinor: 200_00 },
    });
  });
});

describe("resolveHoldingCreationOpening (#1315) · reconciliation", () => {
  test("a cent of rounding is inside the tolerance", () => {
    const resolved = resolveHoldingCreationOpening({
      ...CONFIRMATION,
      openingValueMinor: 164_65,
    });

    expect(resolved).toEqual({
      ok: true,
      opening: {
        feesMinor: 1_00,
        pricePerUnit: "54.545",
        units: "3",
        valueMinor: 163_64,
      },
    });
  });

  test("terms that do not add up WARN and still apply", () => {
    const resolved = resolveHoldingCreationOpening({
      ...CONFIRMATION,
      openingValueMinor: 200_00,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The declared terms survive: the numbers are the user's (never re-derived
    // from the amount that disagrees with them).
    expect(resolved.opening).toMatchObject({ feesMinor: 1_00, units: "3" });
    // Both figures, with cents: 200,00 € declarados vs 164,64 € calculados.
    expect(resolved.mismatchWarning).toContain("200,00");
    expect(resolved.mismatchWarning).toContain("164,64");
  });

  test("two cents off is already a mismatch", () => {
    const resolved = resolveHoldingCreationOpening({
      ...CONFIRMATION,
      openingValueMinor: 164_66,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mismatchWarning).toBeDefined();
  });
});

describe("resolveHoldingCreationOpening (#1315) · derivation fallback", () => {
  test("no units → the amount ÷ price derivation is unchanged", () => {
    const resolved = resolveHoldingCreationOpening({
      openingValueMinor: 1_500_00,
      pricePerUnit: "150",
    });

    expect(resolved).toEqual({
      ok: true,
      opening: { pricePerUnit: "150", units: "10", valueMinor: 1_500_00 },
    });
  });

  test("a commission without units is carved out before dividing", () => {
    const resolved = resolveHoldingCreationOpening({
      feesMinor: 1_00,
      openingValueMinor: 164_64,
      pricePerUnit: "54,545",
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // 163,64 € ÷ 54,545 € ≈ 3, not the 3,018 the gross amount would give.
    expect(resolved.opening?.units.startsWith("3.0000")).toBe(true);
    expect(resolved.opening).toMatchObject({ feesMinor: 1_00, valueMinor: 163_64 });
    expect(resolved.mismatchWarning).toBeUndefined();
  });

  test("nothing declared → no opening (an empty container, never a 0 € valuation)", () => {
    expect(resolveHoldingCreationOpening({})).toEqual({ ok: true, opening: null });
  });
});

describe("resolveHoldingCreationOpening (#1325) · value-only", () => {
  test("only the amount, allowed → 1 participación at the total value", () => {
    const resolved = resolveHoldingCreationOpening(
      { openingValueMinor: 574_48 },
      { allowValueOnly: true },
    );

    expect(resolved).toEqual({
      ok: true,
      opening: { pricePerUnit: "574.48", units: "1", valueMinor: 574_48 },
      // The marker the card's tracking warning keys on: assigning a symbol
      // over the fake unit would revalue the holding to one share's NAV.
      valueOnly: true,
    });
  });

  test("a commission rides on the cost basis — it does NOT shrink today's balance (#1329)", () => {
    // The declared amount is a BALANCE the user is reading off a statement, not
    // an order's cash: carving the euro out would make the app disagree with the
    // document. The fee stays on the operation, where the cost basis keeps it.
    const resolved = resolveHoldingCreationOpening(
      { feesMinor: 1_00, openingValueMinor: 574_48 },
      { allowValueOnly: true },
    );

    expect(resolved).toEqual({
      ok: true,
      opening: {
        feesMinor: 1_00,
        pricePerUnit: "574.48",
        units: "1",
        valueMinor: 574_48,
      },
      valueOnly: true,
    });
  });

  test("only the amount, NOT allowed (symbol-ful alta) → still asks for the price", () => {
    const resolved = resolveHoldingCreationOpening(
      { openingValueMinor: 574_48 },
      { allowValueOnly: false },
    );

    expect(resolved).toMatchObject({ ok: false });
    if (resolved.ok) return;
    expect(resolved.error).toMatch(/precio por unidad/);
  });

  test("a declared price that does not parse never falls back to value-only", () => {
    const resolved = resolveHoldingCreationOpening(
      { openingValueMinor: 574_48, pricePerUnit: "unos 54 euros" },
      { allowValueOnly: true },
    );

    expect(resolved).toMatchObject({ ok: false });
  });

  test("declared units keep needing their price even when value-only is allowed", () => {
    const resolved = resolveHoldingCreationOpening(
      { openingValueMinor: 574_48, units: "3" },
      { allowValueOnly: true },
    );

    expect(resolved).toMatchObject({ ok: false });
    if (resolved.ok) return;
    expect(resolved.error).toMatch(/precio por unidad/);
  });

  test("a commission bigger than the balance is a cost, not an impossibility (#1329)", () => {
    // Under the balance reading there is no arithmetic to break: the position is
    // worth what the user says it is worth, and an outsized fee simply lands in
    // the cost basis, where the return reports it as the loss it is.
    const resolved = resolveHoldingCreationOpening(
      { feesMinor: 600_00, openingValueMinor: 574_48 },
      { allowValueOnly: true },
    );

    expect(resolved).toMatchObject({
      ok: true,
      opening: { feesMinor: 600_00, units: "1", valueMinor: 574_48 },
    });
  });
});

describe("resolveHoldingCreationOpening (#1315) · rejections", () => {
  test("rejects an amount in euros instead of cents rather than rounding it", () => {
    const resolved = resolveHoldingCreationOpening({
      openingValueMinor: 164.64,
      pricePerUnit: "54,545",
    });

    expect(resolved).toMatchObject({ ok: false });
    if (resolved.ok) return;
    expect(resolved.error).toMatch(/CÉNTIMOS/);
  });

  test("rejects a commission with decimals rather than rounding it", () => {
    const resolved = resolveHoldingCreationOpening({
      feesMinor: 1.5,
      pricePerUnit: "54,545",
      units: "3",
    });

    expect(resolved).toMatchObject({ ok: false });
  });

  test("rejects a negative commission", () => {
    expect(
      resolveHoldingCreationOpening({ feesMinor: -100, pricePerUnit: "10", units: "3" }),
    ).toMatchObject({ ok: false });
  });

  test("rejects units that are not a positive number", () => {
    for (const units of ["", "0", "-3", "tres"]) {
      expect(resolveHoldingCreationOpening({ pricePerUnit: "10", units })).toMatchObject({
        ok: false,
      });
    }
  });

  test("rejects a commission that swallows the whole amount", () => {
    const resolved = resolveHoldingCreationOpening({
      feesMinor: 200_00,
      openingValueMinor: 164_64,
      pricePerUnit: "54,545",
    });

    expect(resolved).toMatchObject({ ok: false });
  });

  test("asks for the price when only the amount is declared", () => {
    const resolved = resolveHoldingCreationOpening({ openingValueMinor: 1_000_00 });

    expect(resolved).toMatchObject({ ok: false });
    if (resolved.ok) return;
    expect(resolved.error).toMatch(/precio por unidad/);
  });

  test("asks for the amount when only the price is declared", () => {
    const resolved = resolveHoldingCreationOpening({ pricePerUnit: "150" });

    expect(resolved).toMatchObject({ ok: false });
    if (resolved.ok) return;
    expect(resolved.error).toMatch(/cuánto tienes hoy/);
  });
});

describe("openingCardBreakdown (#1315)", () => {
  test("formats títulos, precio y comisión in es-ES", () => {
    expect(
      openingCardBreakdown({
        feesMinor: 1_00,
        pricePerUnit: "54.545",
        units: "3",
        valueMinor: 163_64,
      }),
    ).toEqual({
      fees: euros(1_00),
      pricePerUnit: `${units("54.545")} €`,
      units: units("3"),
    });
  });

  test("omits the commission when there was none, and shows derived units", () => {
    expect(
      openingCardBreakdown({
        pricePerUnit: "54.55",
        units: "3.01814849",
        valueMinor: 164_64,
      }),
    ).toEqual({ pricePerUnit: `${units("54.55")} €`, units: "3,018148" });
  });
});

import { multiplyToMinor } from "@worthline/domain";
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

  test("the derived value comes from the SAME engine as the units (#1395)", () => {
    // The units are cut at six decimals, so at a five-figure unit price they no
    // longer fold back to the declared amount to the cent. The plan's valueMinor is
    // what the impact card promises and the operation is what gets written, so the
    // two must be one figure: units × price, never the amount that was typed.
    const resolved = resolveHoldingCreationOpening({
      openingValueMinor: 1_234_56,
      pricePerUnit: "100000",
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok || !resolved.opening) return;
    const { pricePerUnit, units, valueMinor } = resolved.opening;
    expect(units).toBe("0.012346");
    expect(valueMinor).toBe(multiplyToMinor(units, pricePerUnit));
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
      opening: {
        // A declared BALANCE states no cost, and since #1505 the row says so
        // instead of passing for a purchase made at today's price.
        costBasisGrade: "value_only",
        pricePerUnit: "574.48",
        units: "1",
        valueMinor: 574_48,
      },
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
        costBasisGrade: "value_only",
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

  test("a commission bigger than the balance applies, but WARNS (#1329)", () => {
    // Under the balance reading there is no arithmetic to break: the position is
    // worth what the user says it is worth, and an outsized fee lands in the cost
    // basis. The old rejection still caught a euros-for-cents transcription
    // though, so the tripwire survives as a warning instead of a refusal.
    const resolved = resolveHoldingCreationOpening(
      { feesMinor: 600_00, openingValueMinor: 574_48 },
      { allowValueOnly: true },
    );

    expect(resolved).toMatchObject({
      ok: true,
      opening: { feesMinor: 600_00, units: "1", valueMinor: 574_48 },
    });
    if (!resolved.ok) return;
    expect(resolved.mismatchWarning).toMatch(/comisión/i);
    expect(resolved.mismatchWarning).toMatch(/céntimos/i);
  });

  test("the same sentence with a symbol keeps the balance whole too (#1329)", () => {
    // The symbol-ful path arrives here with the quote already in `pricePerUnit`.
    // Netting the fee out would make «tengo 574,48 €» mean 573,48 € only because
    // the alta had a symbol — the inconsistency the balance decision exists to end.
    const resolved = resolveHoldingCreationOpening(
      { feesMinor: 1_00, openingValueMinor: 574_48, pricePerUnit: "11.90" },
      { valueIsBalance: true },
    );

    expect(resolved).toMatchObject({
      ok: true,
      opening: { feesMinor: 1_00, valueMinor: 574_48 },
    });
  });

  test("an ORDER still derives its units net of the commission (#1315)", () => {
    const resolved = resolveHoldingCreationOpening({
      feesMinor: 1_00,
      openingValueMinor: 574_48,
      pricePerUnit: "11.90",
    });

    expect(resolved).toMatchObject({ ok: true, opening: { valueMinor: 573_48 } });
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

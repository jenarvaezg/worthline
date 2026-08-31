/**
 * Tests for the declared availability date and what it does to a reparto (#1528).
 * Run: cd packages/domain && npx vitest run fire-capital-availability
 */
import { describe, expect, it } from "vitest";

import {
  availabilityAwareAnnuity,
  resolveCapitalAvailability,
  yearsUntilAvailable,
} from "./fire-capital-availability";

const TODAY = "2026-08-31";

describe("yearsUntilAvailable (#1528)", () => {
  it("es 0 cuando la fecha ya pasó — ese capital está disponible hoy", () => {
    expect(yearsUntilAvailable("2020-01-01", TODAY)).toBe(0);
    expect(yearsUntilAvailable(TODAY, TODAY)).toBe(0);
  });

  it("es el menor entero de años que alcanza la fecha, por calendario", () => {
    // Hoy + 9 años = 2035-08-31, que ya pasa del 1 de junio; hoy + 8 no llega.
    expect(yearsUntilAvailable("2035-06-01", TODAY)).toBe(9);
    // Un aniversario exacto se alcanza en el pago de ese año, no en el siguiente.
    expect(yearsUntilAvailable("2027-08-31", TODAY)).toBe(1);
    // Un día después del aniversario ya necesita el pago siguiente.
    expect(yearsUntilAvailable("2027-09-01", TODAY)).toBe(2);
    // Dentro del mismo año natural pero en el futuro: no está disponible hoy.
    expect(yearsUntilAvailable("2026-12-01", TODAY)).toBe(1);
  });

  it("cuenta por calendario y no por días, así que un bisiesto no desplaza el año", () => {
    // 2028 es bisiesto: de 2027-08-31 a 2031-08-31 hay 1.462 días, no 1.460.
    expect(yearsUntilAvailable("2031-08-31", "2027-08-31")).toBe(4);
  });
});

describe("resolveCapitalAvailability (#1528)", () => {
  it("sin día de lectura no resuelve nada y lo dice", () => {
    const availability = resolveCapitalAvailability({
      declared: [{ amountMinor: 500_000, availableFrom: "2035-06-01" }],
      sellableMinor: 10_000_000,
      todayISO: undefined,
      undeclaredMinor: 0,
    });

    expect(availability.resolved).toBe(false);
    expect(availability.tranches).toEqual([]);
    expect(availability.lockedMinor).toBe(0);
  });

  it("deja fuera lo que ya está disponible: una fecha pasada no bloquea nada", () => {
    const availability = resolveCapitalAvailability({
      declared: [
        { amountMinor: 500_000, availableFrom: "2020-01-01" },
        { amountMinor: 300_000, availableFrom: "2035-06-01" },
      ],
      sellableMinor: 10_000_000,
      todayISO: TODAY,
      undeclaredMinor: 0,
    });

    expect(availability.tranches).toEqual([{ amountMinor: 300_000, yearsUntil: 9 }]);
    expect(availability.lockedMinor).toBe(300_000);
  });

  it("agrupa los tramos que se liberan el mismo año", () => {
    const availability = resolveCapitalAvailability({
      declared: [
        { amountMinor: 100_000, availableFrom: "2035-06-01" },
        { amountMinor: 250_000, availableFrom: "2035-01-15" },
        { amountMinor: 400_000, availableFrom: "2030-01-01" },
      ],
      sellableMinor: 10_000_000,
      todayISO: TODAY,
      undeclaredMinor: 0,
    });

    expect(availability.tranches).toEqual([
      { amountMinor: 400_000, yearsUntil: 4 },
      { amountMinor: 350_000, yearsUntil: 9 },
    ]);
  });

  it("topa lo bloqueado al vendible NETO, recortando por el tramo que antes se libera", () => {
    // La deuda y la reserva se pagan con lo que se puede tocar; lo que quede por
    // pagar sale del primer dinero que se libere, no del último.
    const availability = resolveCapitalAvailability({
      declared: [
        { amountMinor: 600_000, availableFrom: "2030-01-01" },
        { amountMinor: 500_000, availableFrom: "2035-01-01" },
      ],
      sellableMinor: 700_000,
      todayISO: TODAY,
      undeclaredMinor: 0,
    });

    expect(availability.tranches).toEqual([
      { amountMinor: 200_000, yearsUntil: 4 },
      { amountMinor: 500_000, yearsUntil: 9 },
    ]);
    expect(availability.lockedMinor).toBe(700_000);
  });

  it("arrastra el capital a plazo sin declarar, que es un hueco y no un cero", () => {
    const availability = resolveCapitalAvailability({
      declared: [],
      sellableMinor: 10_000_000,
      todayISO: TODAY,
      undeclaredMinor: 4_979_55,
    });

    expect(availability.undeclaredMinor).toBe(4_979_55);
    expect(availability.lockedMinor).toBe(0);
    expect(availability.resolved).toBe(true);
  });
});

describe("availabilityAwareAnnuity (#1528)", () => {
  const PRINCIPAL = 10_000_000;
  const RATE = 0.035;
  const YEARS = 20;

  /** La anualidad de siempre: `P · r / (1 − (1+r)^−n)`. */
  const plain = Math.round((PRINCIPAL * RATE) / (1 - (1 + RATE) ** -YEARS));

  it("sin tramos bloqueados devuelve exactamente la anualidad de siempre", () => {
    expect(
      availabilityAwareAnnuity({
        principalMinor: PRINCIPAL,
        realReturn: RATE,
        tranches: [],
        years: YEARS,
      }),
    ).toEqual({ annualMinor: plain, limitedByAvailability: false });
  });

  it("con retorno cero reparte linealmente, y el bloqueo sigue mandando", () => {
    expect(
      availabilityAwareAnnuity({
        principalMinor: PRINCIPAL,
        realReturn: 0,
        tranches: [],
        years: YEARS,
      }).annualMinor,
    ).toBe(PRINCIPAL / YEARS);

    // Los 9 primeros años se financian solo con los 2.000.000 libres, y eso es
    // menos que el reparto lineal de los 20: manda el bloqueo.
    const locked = availabilityAwareAnnuity({
      principalMinor: PRINCIPAL,
      realReturn: 0,
      tranches: [{ amountMinor: 8_000_000, yearsUntil: 10 }],
      years: YEARS,
    });
    expect(locked).toEqual({
      annualMinor: Math.round(2_000_000 / 9),
      limitedByAvailability: true,
    });
  });

  it("no reparte, en un año dado, capital cuya fecha es posterior a ese año", () => {
    const locked = availabilityAwareAnnuity({
      principalMinor: PRINCIPAL,
      realReturn: RATE,
      tranches: [{ amountMinor: 6_000_000, yearsUntil: 10 }],
      years: YEARS,
    });

    expect(locked.limitedByAvailability).toBe(true);
    expect(locked.annualMinor).toBeLessThan(plain);
    // El techo es lo que los 4.000.000 libres soportan durante los 9 años que
    // faltan para que se libere el resto — la restricción que muerde.
    expect(locked.annualMinor).toBe(
      Math.round((4_000_000 * RATE) / (1 - (1 + RATE) ** -9)),
    );
  });

  it("un bloqueo que se libera antes de que muerda no cambia la cifra", () => {
    // 1.000.000 bloqueado un año: los 9.000.000 libres soportan de sobra el nivel
    // de la anualidad completa durante ese primer año.
    expect(
      availabilityAwareAnnuity({
        principalMinor: PRINCIPAL,
        realReturn: RATE,
        tranches: [{ amountMinor: 1_000_000, yearsUntil: 2 }],
        years: YEARS,
      }),
    ).toEqual({ annualMinor: plain, limitedByAvailability: false });
  });

  it("el capital que no se libera dentro del horizonte no se reparte nunca", () => {
    const locked = availabilityAwareAnnuity({
      principalMinor: PRINCIPAL,
      realReturn: RATE,
      tranches: [{ amountMinor: 4_000_000, yearsUntil: 40 }],
      years: YEARS,
    });

    expect(locked.limitedByAvailability).toBe(true);
    expect(locked.annualMinor).toBe(
      Math.round((6_000_000 * RATE) / (1 - (1 + RATE) ** -YEARS)),
    );
  });

  it("con varios tramos manda la restricción más estrecha, no la última", () => {
    const locked = availabilityAwareAnnuity({
      principalMinor: PRINCIPAL,
      realReturn: RATE,
      tranches: [
        { amountMinor: 5_000_000, yearsUntil: 5 },
        { amountMinor: 3_000_000, yearsUntil: 15 },
      ],
      years: YEARS,
    });

    // Dos candidatos: los 2.000.000 libres durante 4 años, y los 7.000.000
    // disponibles a partir del quinto durante 14. Manda el menor.
    const first = (2_000_000 * RATE) / (1 - (1 + RATE) ** -4);
    const second = (7_000_000 * RATE) / (1 - (1 + RATE) ** -14);
    expect(locked.annualMinor).toBe(Math.round(Math.min(first, second)));
    expect(locked.limitedByAvailability).toBe(true);
  });
});

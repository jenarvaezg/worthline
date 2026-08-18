import { formatUnits, multiplyToMinor } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  deriveOpeningUnits,
  OPENING_UNITS_DECIMALS,
  openingCaptureCopy,
  resolveOpeningCapture,
  resolveOpeningDate,
} from "./investment-units";

describe("deriveOpeningUnits — saldo ÷ precio (#597)", () => {
  test("derives units from an es-ES saldo and price, round-tripping to the saldo", () => {
    const result = deriveOpeningUnits({ saldoRaw: "1.000,00", priceRaw: "50.000,00" });
    expect(result).toEqual({ ok: true, units: "0.02", price: "50000.00" });
  });

  test("caps a non-exact division at the declared precision (#1395: no 20 decimals)", () => {
    // The real case: 1.089,79 € of a fund at 319,59 € used to persist
    // 3,40996276479239025001 participaciones — a precision no bank publishes.
    const result = deriveOpeningUnits({ saldoRaw: "1.089,79", priceRaw: "319,59" });
    expect(result).toEqual({ ok: true, units: "3.409963", price: "319.59" });
    expect(result.ok && result.units.split(".")[1]?.length).toBe(OPENING_UNITS_DECIMALS);
  });

  test("the capped units still fold back to the typed saldo, to the cent", () => {
    const result = deriveOpeningUnits({ saldoRaw: "1.089,79", priceRaw: "319,59" });
    expect(result.ok && multiplyToMinor(result.units, result.price)).toBe(1_089_79);
  });

  test("an exact division carries NO padding zeros", () => {
    expect(deriveOpeningUnits({ saldoRaw: "300,00", priceRaw: "3,00" })).toEqual({
      ok: true,
      units: "100",
      price: "3.00",
    });
    expect(deriveOpeningUnits({ saldoRaw: "100,00", priceRaw: "3,00" })).toMatchObject({
      units: "33.333333",
    });
  });

  test("flags a missing/zero price (the manual-fallback case)", () => {
    expect(deriveOpeningUnits({ saldoRaw: "1.000,00", priceRaw: "" })).toEqual({
      ok: false,
      reason: "price",
    });
    expect(deriveOpeningUnits({ saldoRaw: "1.000,00", priceRaw: "0,00" })).toEqual({
      ok: false,
      reason: "price",
    });
  });

  test("flags a missing/zero saldo before complaining about price", () => {
    expect(deriveOpeningUnits({ saldoRaw: "", priceRaw: "215,40" })).toEqual({
      ok: false,
      reason: "saldo",
    });
  });

  test("the declared precision is one the app can READ — formatUnits loses no digit", () => {
    // The whole reason the cut is six (#1395): the app's units voice renders at most
    // six decimals, so a stored figure at this precision survives being displayed.
    // Raising OPENING_UNITS_DECIMALS without raising that voice would silently make
    // the hint round what the ficha shows.
    const units = deriveOpeningUnits({ saldoRaw: "1.089,79", priceRaw: "319,59" });
    expect(units.ok && formatUnits(units.units)).toBe("3,409963");
  });

  test("at a five-figure unit price the cut costs cents — the bounded, documented price", () => {
    // Pinned deliberately: 1.234,56 € of BTC at 100.000 € folds back as 1.234,60 €.
    // Any consumer showing a value beside these units must derive it FROM them.
    const result = deriveOpeningUnits({
      saldoRaw: "1.234,56",
      priceRaw: "100.000,00",
    });
    expect(result).toMatchObject({ units: "0.012346" });
    expect(result.ok && multiplyToMinor(result.units, result.price)).toBe(1_234_60);
  });
});

describe("resolveOpeningDate — «Fecha del saldo» (#1395)", () => {
  const TODAY = "2026-08-17";

  test("an untouched field means today — the pre-#1395 behavior, unchanged", () => {
    expect(resolveOpeningDate("", TODAY)).toEqual({ ok: true, date: TODAY });
    expect(resolveOpeningDate("   ", TODAY)).toEqual({ ok: true, date: TODAY });
  });

  test("a past date is the date the saldo is read at", () => {
    expect(resolveOpeningDate("2026-07-31", TODAY)).toEqual({
      ok: true,
      date: "2026-07-31",
    });
  });

  test("today itself is accepted", () => {
    expect(resolveOpeningDate(TODAY, TODAY)).toEqual({ ok: true, date: TODAY });
  });

  test("a future date is refused — a saldo you have not had yet is not history", () => {
    const result = resolveOpeningDate("2026-09-01", TODAY);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("futura");
  });

  test("an unreadable date is refused rather than silently read as today", () => {
    const result = resolveOpeningDate("31/07/2026", TODAY);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("fecha");
  });
});

describe("resolveOpeningDate — a real day, not just an ISO shape (#1395)", () => {
  const TODAY = "2026-08-17";

  test("a date the calendar does not have is refused, not read as the next month", () => {
    // `2026-02-30` passes any \d{4}-\d{2}-\d{2} regex and sorts before today, yet
    // `new Date` reads it as 2 mar: the hint would say one day and the operation
    // would carry another, plus an executed_at/dateKey no calendar can read back.
    const result = resolveOpeningDate("2026-02-30", TODAY);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("no es válida");
  });

  test("a zeroed date is refused instead of blowing up the reading", () => {
    expect(resolveOpeningDate("0000-00-00", TODAY)).toEqual({
      ok: false,
      error: "La fecha del saldo no es válida: elígela en el calendario.",
    });
    // The hint reads the resolved date, so the refusal must arrive BEFORE it (this
    // threw RangeError while the shape check was the only gate).
    expect(() =>
      openingCaptureCopy({
        dateRaw: "0000-00-00",
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
        today: TODAY,
      }),
    ).not.toThrow();
  });
});

describe("resolveOpeningCapture — one answer for the whole capture (#1395)", () => {
  const TODAY = "2026-08-17";

  test("resolves units, price and the date the opening is stamped with", () => {
    expect(
      resolveOpeningCapture({
        dateRaw: "2026-07-31",
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
        today: TODAY,
      }),
    ).toEqual({ ok: true, executedAt: "2026-07-31", price: "319.59", units: "3.409963" });
  });

  test("an untouched date resolves to today", () => {
    expect(
      resolveOpeningCapture({
        dateRaw: "",
        priceRaw: "50.000,00",
        saldoRaw: "1.000,00",
        today: TODAY,
      }),
    ).toMatchObject({ executedAt: TODAY, units: "0.02" });
  });

  test("the money is checked BEFORE the date — the guidance names what is missing", () => {
    expect(
      resolveOpeningCapture({
        dateRaw: "2026-12-31",
        priceRaw: "",
        saldoRaw: "1.000,00",
        today: TODAY,
      }),
    ).toEqual({
      ok: false,
      error:
        "Necesito el precio por unidad para calcular las participaciones. Búscalo o escríbelo a mano.",
    });
  });

  test("a refused date refuses the whole capture", () => {
    expect(
      resolveOpeningCapture({
        dateRaw: "2026-02-30",
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
        today: TODAY,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("openingCaptureCopy — the pane says what will be persisted (#1395)", () => {
  const TODAY = "2026-08-17";

  test("invites the saldo while there is nothing to derive", () => {
    expect(
      openingCaptureCopy({
        dateRaw: "",
        priceRaw: "319,59",
        saldoRaw: "",
        today: TODAY,
      }),
    ).toEqual({
      backdatedTo: null,
      hint: "Escribe el saldo para ver las participaciones.",
      priceNote: null,
      refused: false,
    });
  });

  test("shows the units EXACTLY as derived — six decimals, es-ES", () => {
    expect(
      openingCaptureCopy({
        dateRaw: "",
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
        today: TODAY,
      }).hint,
    ).toBe("≈ 3,409963 participaciones.");
  });

  test("a past saldo date says the history gets rebuilt, and re-labels the pane", () => {
    const copy = openingCaptureCopy({
      dateRaw: "2026-07-31",
      priceRaw: "319,59",
      saldoRaw: "1.089,79",
      today: TODAY,
    });
    expect(copy.hint).toContain("3,409963 participaciones");
    expect(copy.hint).toContain("31 jul 2026");
    expect(copy.hint).toContain("histórico");
    // The pane re-reads itself against that date: the price it divides by is that
    // day's NAV, not the live quote the field was prefilled with.
    expect(copy.backdatedTo).toBe("31 jul 2026");
    expect(copy.refused).toBe(false);
  });

  test("the price note CHECKS the live quote instead of only asking for the NAV", () => {
    const stale = openingCaptureCopy({
      dateRaw: "2026-07-31",
      livePriceRaw: "319,59",
      priceRaw: "319,59",
      saldoRaw: "1.089,79",
      today: TODAY,
    });
    expect(stale.priceNote).toBe(
      "Ese precio es el de HOY, en vivo: cámbialo por el valor liquidativo del 31 jul 2026.",
    );

    const edited = openingCaptureCopy({
      dateRaw: "2026-07-31",
      livePriceRaw: "319,59",
      priceRaw: "312,40",
      saldoRaw: "1.089,79",
      today: TODAY,
    });
    expect(edited.priceNote).toBe(
      "Pon el valor liquidativo del 31 jul 2026, no el de hoy: de ahí salen las participaciones.",
    );
  });

  test("a saldo dated today is not backdated — nothing re-labels", () => {
    expect(
      openingCaptureCopy({
        dateRaw: TODAY,
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
        today: TODAY,
      }),
    ).toMatchObject({ backdatedTo: null, refused: false });
  });

  test("a bad date takes over as a REFUSAL — the same message the server answers", () => {
    expect(
      openingCaptureCopy({
        dateRaw: "2026-12-01",
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
        today: TODAY,
      }),
    ).toEqual({
      backdatedTo: null,
      hint: "La fecha del saldo no puede ser futura.",
      priceNote: null,
      refused: true,
    });
  });
});

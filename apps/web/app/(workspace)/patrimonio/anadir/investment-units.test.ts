import { formatMoneyMinorExact, formatUnits, multiplyToMinor } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  deriveOpeningUnits,
  OPENING_UNITS_DECIMALS,
  openingCaptureCopy,
  parseOpeningCostMode,
  resolveOpeningCapture,
  resolveOpeningCost,
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

describe("resolveOpeningDate — «¿Desde cuándo la tienes?» (#1395, #1490)", () => {
  const TODAY = "2026-08-17";

  test("an untouched field means today — the pre-#1395 behavior, unchanged", () => {
    expect(resolveOpeningDate("", TODAY)).toEqual({ ok: true, date: TODAY });
    expect(resolveOpeningDate("   ", TODAY)).toEqual({ ok: true, date: TODAY });
  });

  test("a past date is the day the position starts existing", () => {
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
      error: "La fecha de la posición no es válida: elígela en el calendario.",
    });
    // The hint reads the resolved date, so the refusal must arrive BEFORE it (this
    // threw RangeError while the shape check was the only gate).
    expect(() =>
      openingCaptureCopy({
        costMode: "total",
        costRaw: "",
        dateRaw: "0000-00-00",
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
        today: TODAY,
      }),
    ).not.toThrow();
  });
});

describe("resolveOpeningCost — el coste de adquisición declarado (#1490)", () => {
  // Jorge's real position: 27 uds worth 5.865,75 € today, bought for 4.999,86 €.
  const UNITS = "27" as const;

  test("un coste vacío es la marca «sin coste real»: no se inventa ninguno", () => {
    expect(resolveOpeningCost({ costMode: "total", costRaw: "", units: UNITS })).toEqual({
      declared: false,
      ok: true,
    });
    expect(resolveOpeningCost({ costMode: "unit", costRaw: "  ", units: UNITS })).toEqual(
      {
        declared: false,
        ok: true,
      },
    );
  });

  test("un coste TOTAL se reparte entre los títulos: 4.999,86 € → 185,18 €/ud", () => {
    expect(
      resolveOpeningCost({ costMode: "total", costRaw: "4.999,86", units: UNITS }),
    ).toEqual({ costMinor: 499_986, declared: true, ok: true, pricePerUnit: "185.18" });
  });

  test("un precio MEDIO se persiste tal cual, y el total sale de él", () => {
    expect(
      resolveOpeningCost({ costMode: "unit", costRaw: "185,18", units: UNITS }),
    ).toEqual({ costMinor: 499_986, declared: true, ok: true, pricePerUnit: "185.18" });
  });

  test("el coste que no cuadra a la unidad sigue cuadrando al céntimo", () => {
    // A fund's units are not round: 1.000,00 € over 3,409963 participaciones is an
    // endless decimal, and what must survive is the cost the user typed.
    const resolved = resolveOpeningCost({
      costMode: "total",
      costRaw: "1.000,00",
      units: "3.409963",
    });
    expect(resolved).toMatchObject({ costMinor: 100_000, declared: true, ok: true });
    expect(
      resolved.ok &&
        resolved.declared &&
        multiplyToMinor("3.409963", resolved.pricePerUnit),
    ).toBe(100_000);
  });

  test("un coste ilegible o cero se rechaza — nunca se lee como «no lo sé»", () => {
    for (const costRaw of ["cuatro mil", "0,00", "-100"]) {
      const resolved = resolveOpeningCost({ costMode: "total", costRaw, units: UNITS });
      expect(resolved.ok).toBe(false);
      expect(!resolved.ok && resolved.error).toContain("coste");
    }
  });

  test("el modo del formulario se lee cerrado: lo que no reconoce es «no me lo has dicho»", () => {
    expect(parseOpeningCostMode("unit")).toBe("unit");
    expect(parseOpeningCostMode("total")).toBe("total");
    expect(parseOpeningCostMode("")).toBeNull();
    expect(parseOpeningCostMode("cualquier-cosa")).toBeNull();
  });

  test("un coste sin modo se RECHAZA: las dos lecturas se llevan 27x (#1490)", () => {
    // 185,18 € read as a total over 27 títulos is a 6,86 € cost basis and a plusvalía
    // of 5.680 € nobody has. Defaulting here would write that silently, forever.
    const resolved = resolveOpeningCost({
      costMode: null,
      costRaw: "185,18",
      units: UNITS,
    });
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error).toContain(
      "el total o el precio por participación",
    );
  });

  test("sin coste, un modo ausente no molesta a nadie", () => {
    expect(resolveOpeningCost({ costMode: null, costRaw: "", units: UNITS })).toEqual({
      declared: false,
      ok: true,
    });
  });
});

describe("resolveOpeningCapture — one answer for the whole capture (#1395)", () => {
  const TODAY = "2026-08-17";

  test("resolves units, price and the date the opening is stamped with", () => {
    expect(
      resolveOpeningCapture({
        costMode: "total",
        costRaw: "",
        dateRaw: "2026-07-31",
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
        today: TODAY,
      }),
    ).toEqual({ ok: true, executedAt: "2026-07-31", price: "319.59", units: "3.409963" });
  });

  test("el coste declarado es el precio con el que se escribe la apertura (#1490)", () => {
    // The whole point: units come from what the position is WORTH today, the price
    // the operation carries comes from what it COST. Jorge's alta stops reading as
    // «comprado hoy por lo que vale hoy» and his 865,89 € of latent gain appear.
    expect(
      resolveOpeningCapture({
        costMode: "total",
        costRaw: "4.999,86",
        dateRaw: "2025-12-15",
        priceRaw: "217,25",
        saldoRaw: "5.865,75",
        today: TODAY,
      }),
    ).toEqual({ ok: true, executedAt: "2025-12-15", price: "185.18", units: "27" });
  });

  test("sin coste, la apertura sigue naciendo al precio de hoy (statu quo, elegido)", () => {
    expect(
      resolveOpeningCapture({
        costMode: "total",
        costRaw: "",
        dateRaw: "",
        priceRaw: "217,25",
        saldoRaw: "5.865,75",
        today: TODAY,
      }),
    ).toEqual({ ok: true, executedAt: TODAY, price: "217.25", units: "27" });
  });

  test("un coste ilegible refusa la captura entera, antes de escribir nada", () => {
    expect(
      resolveOpeningCapture({
        costMode: "total",
        costRaw: "cuatro mil",
        dateRaw: "",
        priceRaw: "217,25",
        saldoRaw: "5.865,75",
        today: TODAY,
      }),
    ).toMatchObject({ ok: false });
  });

  test("an untouched date resolves to today", () => {
    expect(
      resolveOpeningCapture({
        costMode: "total",
        costRaw: "",
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
        costMode: "total",
        costRaw: "",
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
        costMode: "total",
        costRaw: "",
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
  const NOTHING_DECLARED = { costMode: "total", costRaw: "", today: TODAY } as const;

  test("invites the saldo while there is nothing to derive", () => {
    expect(
      openingCaptureCopy({
        ...NOTHING_DECLARED,
        dateRaw: "",
        priceRaw: "319,59",
        saldoRaw: "",
      }),
    ).toMatchObject({
      backdatedTo: null,
      hint: "Escribe el saldo para ver las participaciones.",
      refused: false,
    });
  });

  test("shows the units EXACTLY as derived — six decimals, es-ES", () => {
    expect(
      openingCaptureCopy({
        ...NOTHING_DECLARED,
        dateRaw: "",
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
      }).hint,
    ).toBe("≈ 3,409963 participaciones.");
  });

  test("a past date says the history gets rebuilt from that day", () => {
    const copy = openingCaptureCopy({
      ...NOTHING_DECLARED,
      dateRaw: "2026-07-31",
      priceRaw: "319,59",
      saldoRaw: "1.089,79",
    });
    expect(copy.hint).toContain("3,409963 participaciones");
    expect(copy.hint).toContain("31 jul 2026");
    expect(copy.hint).toContain("histórico");
    expect(copy.backdatedTo).toBe("31 jul 2026");
    expect(copy.refused).toBe(false);
  });

  test("a position held since today is not backdated — nothing re-labels", () => {
    expect(
      openingCaptureCopy({
        ...NOTHING_DECLARED,
        dateRaw: TODAY,
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
      }),
    ).toMatchObject({ backdatedTo: null, refused: false });
  });

  test("a bad date takes over as a REFUSAL — the same message the server answers", () => {
    expect(
      openingCaptureCopy({
        ...NOTHING_DECLARED,
        dateRaw: "2026-12-01",
        priceRaw: "319,59",
        saldoRaw: "1.089,79",
      }),
    ).toMatchObject({
      backdatedTo: null,
      hint: "No puedes tener la posición desde una fecha futura.",
      refused: true,
    });
  });
});

describe("openingCaptureCopy — el coste se lee en vivo (#1490)", () => {
  const TODAY = "2026-08-19";
  /** Jorge's alta: 5.865,75 € of SXR1 today at 217,25 €, bought for 4.999,86 €. */
  const JORGE = { dateRaw: "2025-12-15", priceRaw: "217,25", saldoRaw: "5.865,75" };
  const money = (amountMinor: number) =>
    formatMoneyMinorExact({ amountMinor, currency: "EUR" });

  test("sin coste dice que no habrá plusvalía — la salida honesta, no una en blanco", () => {
    const copy = openingCaptureCopy({
      ...JORGE,
      costMode: "total",
      costRaw: "",
      today: TODAY,
    });
    expect(copy.costNote).toContain("Sin coste");
    expect(copy.costNote).toContain("plusvalía");
    // A backdated position without a cost rebuilds its history at TODAY's price:
    // the only figure the app has, and the user has to know that is what happens.
    expect(copy.costNote).toContain("15 dic 2025");
    expect(copy.refused).toBe(false);
  });

  test("un coste total se devuelve como precio medio Y como la plusvalía que destapa", () => {
    const copy = openingCaptureCopy({
      ...JORGE,
      costMode: "total",
      costRaw: "4.999,86",
      today: TODAY,
    });
    // The price voice (`formatPrice`), not the money voice: the unit price echoed is
    // the figure the operation will carry, at the precision it is stored with.
    expect(copy.costNote).toContain("185,18 € por participación");
    expect(copy.costNote).toContain(`+${money(865_89)}`);
    expect(copy.costNote).toContain("latente");
  });

  test("un precio medio se devuelve como el coste total que suma", () => {
    const copy = openingCaptureCopy({
      ...JORGE,
      costMode: "unit",
      costRaw: "185,18",
      today: TODAY,
    });
    expect(copy.costNote).toContain(money(4_999_86));
    expect(copy.costNote).toContain(`+${money(865_89)}`);
  });

  test("una posición en pérdidas lo dice como minusvalía, con su signo", () => {
    const copy = openingCaptureCopy({
      ...JORGE,
      costMode: "total",
      costRaw: "6.500,00",
      today: TODAY,
    });
    expect(copy.costNote).toContain("minusvalía");
    // Read through the app's own money voice, so the assertion cannot drift from it
    // over an invisible character (the euro sign arrives behind a NBSP).
    expect(copy.costNote).toContain(money(-634_25));
  });

  test("un coste igual al valor de hoy no finge plusvalía ninguna", () => {
    const copy = openingCaptureCopy({
      ...JORGE,
      costMode: "total",
      costRaw: "5.865,75",
      today: TODAY,
    });
    expect(copy.costNote).toContain("ni plusvalía ni minusvalía");
  });

  test("un coste ilegible se refusa JUNTO A SU CAMPO, sin borrar las participaciones", () => {
    const copy = openingCaptureCopy({
      ...JORGE,
      costMode: "total",
      costRaw: "cuatro mil",
      today: TODAY,
    });
    expect(copy.costRefused).toBe(true);
    expect(copy.costNote).toContain("coste de adquisición no se lee");
    // The units reading is about the saldo and the price: it keeps answering.
    expect(copy.refused).toBe(false);
    expect(copy.hint).toContain("27 participaciones");
  });

  test("sin títulos todavía no hay coste que repartir: el pane pide el saldo primero", () => {
    const copy = openingCaptureCopy({
      costMode: "total",
      costRaw: "4.999,86",
      dateRaw: "",
      priceRaw: "217,25",
      saldoRaw: "",
      today: TODAY,
    });
    expect(copy.refused).toBe(false);
    expect(copy.hint).toBe("Escribe el saldo para ver las participaciones.");
    // Never a blank the island has to fill in for itself: the field says what it is
    // for until there are units to spread a cost over.
    expect(copy.costNote).toBe("El dinero que pusiste, no lo que vale hoy.");
    expect(copy.costRefused).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { resolveHoldingLots } from "./contribution-lots";

const TODAY = "2026-08-31";

describe("resolveHoldingLots sin lotes (la fase 1 intacta, #1528)", () => {
  it("deja el holding entero como hueco cuando nadie ha declarado nada", () => {
    expect(
      resolveHoldingLots({
        availableFrom: undefined,
        holdingMinor: 1_055_658,
        lots: [],
        todayISO: TODAY,
      }),
    ).toEqual({ declared: [], undeclaredMinor: 1_055_658 });
  });

  it("bloquea el holding entero con la fecha única de la fase 1", () => {
    expect(
      resolveHoldingLots({
        availableFrom: "2035-06-01",
        holdingMinor: 1_055_658,
        lots: [],
        todayISO: TODAY,
      }),
    ).toEqual({
      declared: [{ amountMinor: 1_055_658, availableFrom: "2035-06-01" }],
      undeclaredMinor: 0,
    });
  });

  it("no promete nada de un holding que el ámbito no posee", () => {
    expect(
      resolveHoldingLots({
        availableFrom: "2035-06-01",
        holdingMinor: 0,
        lots: [{ amountMinor: 100_000, availableFrom: "2035-06-01" }],
        todayISO: TODAY,
      }),
    ).toEqual({ declared: [], undeclaredMinor: 0 });
  });
});

describe("resolveHoldingLots con lotes (#1676)", () => {
  it("saca del bloqueo lo ya vencido y bloquea todo lo demás", () => {
    // El caso que da nombre al ticket: un PP que es dos cosas a la vez.
    const resolved = resolveHoldingLots({
      availableFrom: undefined,
      holdingMinor: 1_000_000,
      lots: [
        { amountMinor: 400_000, availableFrom: "2024-03-01" },
        { amountMinor: 600_000, availableFrom: "2031-05-01" },
      ],
      todayISO: TODAY,
    });

    // 4.000 € vencidos son capital como cualquier otro: no vuelven a aparecer.
    expect(resolved.declared).toEqual([
      { amountMinor: 600_000, availableFrom: "2031-05-01" },
    ]);
    expect(resolved.undeclaredMinor).toBe(0);
  });

  it("un lote que vence HOY ya está disponible", () => {
    const resolved = resolveHoldingLots({
      availableFrom: undefined,
      holdingMinor: 500_000,
      lots: [{ amountMinor: 500_000, availableFrom: TODAY }],
      todayISO: TODAY,
    });

    expect(resolved).toEqual({ declared: [], undeclaredMinor: 0 });
  });

  it("con todos los lotes vencidos no queda ni bloqueo ni hueco", () => {
    const resolved = resolveHoldingLots({
      availableFrom: undefined,
      holdingMinor: 900_000,
      lots: [
        { amountMinor: 400_000, availableFrom: "2014-03-01" },
        { amountMinor: 500_000, availableFrom: "2016-01-01" },
      ],
      todayISO: TODAY,
    });

    expect(resolved).toEqual({ declared: [], undeclaredMinor: 0 });
  });

  // La regla del tope, y la razón de que el bloqueo se derive del VALOR y no de los
  // lotes: un plan sube con el mercado mientras las aportaciones se quedan quietas.
  it("lo que los lotes no explican queda como hueco, nunca como disponible", () => {
    const resolved = resolveHoldingLots({
      availableFrom: undefined,
      holdingMinor: 1_055_658,
      lots: [
        { amountMinor: 400_000, availableFrom: "2024-03-01" },
        { amountMinor: 200_000, availableFrom: "2031-05-01" },
      ],
      todayISO: TODAY,
    });

    expect(resolved.declared).toEqual([
      { amountMinor: 200_000, availableFrom: "2031-05-01" },
    ]);
    // 10.556,58 − 4.000 vencidos − 2.000 fechados = 4.556,58 que nadie ha fechado.
    expect(resolved.undeclaredMinor).toBe(455_658);
  });

  it("topa lo disponible al valor del holding cuando lo vencido lo excede", () => {
    const resolved = resolveHoldingLots({
      availableFrom: undefined,
      holdingMinor: 300_000,
      lots: [{ amountMinor: 400_000, availableFrom: "2014-03-01" }],
      todayISO: TODAY,
    });

    expect(resolved).toEqual({ declared: [], undeclaredMinor: 0 });
  });

  // Un plan que vale menos que sus aportaciones no dice cuál perdió el valor, así que
  // se elige el reparto que libera el dinero MÁS TARDE.
  it("llena el bloqueo por los tramos más lejanos cuando los lotes se pasan del valor", () => {
    const resolved = resolveHoldingLots({
      availableFrom: undefined,
      holdingMinor: 800_000,
      lots: [
        { amountMinor: 400_000, availableFrom: "2014-03-01" },
        { amountMinor: 600_000, availableFrom: "2031-05-01" },
        { amountMinor: 300_000, availableFrom: "2035-09-01" },
      ],
      todayISO: TODAY,
    });

    // Lo declarado (13.000 €) supera al valor (8.000 €), así que el bloqueo cobra
    // primero: los 8.000 € se llenan desde 2035 hacia atrás y no queda disponible.
    expect(resolved.declared).toEqual([
      { amountMinor: 500_000, availableFrom: "2031-05-01" },
      { amountMinor: 300_000, availableFrom: "2035-09-01" },
    ]);
    expect(resolved.undeclaredMinor).toBe(0);
  });

  // El agujero que la regla ingenua dejaba: con lo vencido cubriendo ya todo el valor,
  // servir primero lo disponible dejaba el plan leyéndose como 100 % líquido hoy —
  // prometiendo justo el dinero encerrado que este módulo existe para no prometer.
  it("no da por líquido un plan hundido cuyos lotes pendientes cubren su valor", () => {
    const resolved = resolveHoldingLots({
      availableFrom: undefined,
      holdingMinor: 300_000,
      lots: [
        { amountMinor: 400_000, availableFrom: "2024-03-01" },
        { amountMinor: 600_000, availableFrom: "2031-05-01" },
      ],
      todayISO: TODAY,
    });

    expect(resolved.declared).toEqual([
      { amountMinor: 300_000, availableFrom: "2031-05-01" },
    ]);
    expect(resolved.undeclaredMinor).toBe(0);
  });

  it("devuelve el calendario de antes a después, sea cual sea el orden declarado", () => {
    const resolved = resolveHoldingLots({
      availableFrom: undefined,
      holdingMinor: 900_000,
      lots: [
        { amountMinor: 300_000, availableFrom: "2035-09-01" },
        { amountMinor: 600_000, availableFrom: "2031-05-01" },
      ],
      todayISO: TODAY,
    });

    expect(resolved.declared.map((tranche) => tranche.availableFrom)).toEqual([
      "2031-05-01",
      "2035-09-01",
    ]);
  });

  it("ignora un lote sin importe en vez de fabricar un tramo de cero", () => {
    const resolved = resolveHoldingLots({
      availableFrom: undefined,
      holdingMinor: 500_000,
      lots: [
        { amountMinor: 0, availableFrom: "2031-05-01" },
        { amountMinor: 500_000, availableFrom: "2033-01-01" },
      ],
      todayISO: TODAY,
    });

    expect(resolved.declared).toEqual([
      { amountMinor: 500_000, availableFrom: "2033-01-01" },
    ]);
  });

  // Una escalera declarada es más precisa que el bloque: hacerlas convivir daría dos
  // respuestas a la misma pregunta sobre el mismo capital.
  it("los lotes mandan sobre la fecha única de la fase 1", () => {
    const resolved = resolveHoldingLots({
      availableFrom: "2040-01-01",
      holdingMinor: 1_000_000,
      lots: [
        { amountMinor: 400_000, availableFrom: "2024-03-01" },
        { amountMinor: 600_000, availableFrom: "2031-05-01" },
      ],
      todayISO: TODAY,
    });

    expect(resolved.declared).toEqual([
      { amountMinor: 600_000, availableFrom: "2031-05-01" },
    ]);
  });

  // Sin reloj no se puede decir qué venció, y un lote sin resolver no es un bloqueo.
  it("sin día de lectura no resuelve nada y lo dice como hueco", () => {
    const resolved = resolveHoldingLots({
      availableFrom: undefined,
      holdingMinor: 1_000_000,
      lots: [{ amountMinor: 1_000_000, availableFrom: "2031-05-01" }],
      todayISO: undefined,
    });

    expect(resolved).toEqual({ declared: [], undeclaredMinor: 1_000_000 });
  });
});

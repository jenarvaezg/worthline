/**
 * How «Poner al día» reads to the user (#1884, design A): the line under «Última vez
 * al día», what stays in the band with its remedy, when the button comes back, and
 * the result of a pass. Pure, so every row of the design's table is pinned here.
 */
import { describe, expect, test } from "vitest";

import { serializeMyInvestorSyncOutcome } from "./myinvestor-sync-outcome";
import {
  formatMyInvestorLastGood,
  formatMyInvestorWhen,
  myInvestorHealthEntries,
  myInvestorResultView,
  myInvestorStanding,
  myInvestorUnitsLine,
} from "./myinvestor-sync-view";

const NOW = "2026-11-04T11:04:00.000Z";

function standing(
  overrides: {
    pausedUntil?: string | null;
    stoppedReason?: string | null;
    outcome?: Parameters<typeof serializeMyInvestorSyncOutcome>[0] | null;
    lease?: { until: string; startedAt: string; trigger: "cron" | "manual" } | null;
    savedPassword?: boolean;
  } = {},
) {
  return myInvestorStanding({
    now: NOW,
    savedPassword: overrides.savedPassword ?? true,
    state: {
      lastOutcomeJson: overrides.outcome
        ? serializeMyInvestorSyncOutcome(overrides.outcome)
        : null,
      lease: overrides.lease ? { ...overrides.lease, step: null } : null,
      pausedUntil: overrides.pausedUntil ?? null,
      stoppedReason: overrides.stoppedReason ?? null,
    },
  });
}

describe("the standing of the connection", () => {
  test("with a saved password and nothing wrong: daily, nothing in the band", () => {
    expect(standing()).toEqual({
      blocked: null,
      dailyLine: "Se pone al día sola cada día",
      lastLine: null,
      lasting: null,
      running: null,
      stop: null,
    });
    expect(standing({ savedPassword: false }).dailyLine).toBe(
      "Se pone al día cuando pulsas",
    );
  });

  test("a saved password rejected: deleted, the daily stops, «Escribir la contraseña»", () => {
    const result = standing({
      outcome: { at: NOW, forgotten: true, kind: "password_rejected" },
      savedPassword: false,
    });
    expect(result.dailyLine).toBe("La puesta al día diaria está parada");
    expect(result.lasting).toEqual({
      remedy: { kind: "panel", label: "Escribir la contraseña" },
      text: "MyInvestor no acepta la contraseña guardada, así que worthline la ha borrado. La puesta al día diaria está parada.",
      tone: "error",
    });
  });

  test("the SMS: the daily stops and the remedy is Conexiones, never an SMS of ours", () => {
    const result = standing({
      outcome: { at: NOW, kind: "sms_required" },
      stoppedReason: "sms_required",
    });
    expect(result.dailyLine).toBe("La puesta al día diaria está parada");
    expect(result.lasting).toMatchObject({
      remedy: {
        fold: "reenter",
        kind: "conexiones",
        label: "Volver a entrar en Conexiones →",
      },
      tone: "error",
    });
    expect(result.lasting?.text).toContain("worthline nunca manda un SMS solo");
    expect(result.lasting?.text).not.toContain("Desconecta");
  });

  test("a rejection with no reason: paused, and the button says when it comes back", () => {
    const result = standing({
      outcome: { at: NOW, kind: "rejected_no_reason", until: "2026-11-05T11:04:00.000Z" },
      pausedUntil: "2026-11-05T11:04:00.000Z",
    });
    expect(result.lasting).toMatchObject({ remedy: null, tone: "warn" });
    expect(result.blocked).toEqual({
      line: "«Poner al día» vuelve mañana a las 12:04.",
    });
  });

  test("three rejections: locked until tomorrow", () => {
    const result = standing({
      outcome: { at: NOW, kind: "locked", until: "2026-11-05T00:00:00.000Z" },
      pausedUntil: "2026-11-05T00:00:00.000Z",
      savedPassword: false,
    });
    expect(result.lasting?.text).toContain("tres veces hoy");
    expect(result.blocked).not.toBeNull();
  });

  test("a pause that already ended blocks nothing", () => {
    expect(
      standing({
        outcome: {
          at: NOW,
          kind: "rejected_no_reason",
          until: "2026-11-04T10:00:00.000Z",
        },
        pausedUntil: "2026-11-04T10:00:00.000Z",
      }).blocked,
    ).toBeNull();
  });

  test("the 10 logins of the day, only on that day", () => {
    expect(standing({ outcome: { at: NOW, kind: "limit" } }).blocked).toEqual({
      line: "«Poner al día» vuelve mañana.",
    });
    expect(
      standing({ outcome: { at: "2026-11-03T20:00:00.000Z", kind: "limit" } }).lasting,
    ).toBeNull();
  });

  test("the network: the daily goes on, and trying again is the remedy", () => {
    const result = standing({ outcome: { at: NOW, kind: "network" } });
    expect(result.dailyLine).toBe("Se pone al día sola cada día");
    expect(result.lasting).toMatchObject({
      remedy: { kind: "panel", label: "Volver a intentarlo" },
    });
  });

  test("a pass in progress is said with its hour, until its lease runs out", () => {
    const lease = {
      startedAt: "2026-11-04T06:10:00.000Z",
      trigger: "cron" as const,
      until: "2026-11-04T11:10:00.000Z",
    };
    expect(standing({ lease }).running).toEqual({ since: "07:10" });
    expect(
      standing({ lease: { ...lease, until: "2026-11-04T11:00:00.000Z" } }).running,
    ).toBeNull();
  });
});

describe("the health signals of the connection (#1885)", () => {
  const failedOn = (day: string, step: string) => ({
    at: `${day}T07:13:00.000Z`,
    failedStep: step,
    status: "error" as const,
  });

  test("three days failing on the orders: the design's sentence, out to the connection", () => {
    expect(
      myInvestorHealthEntries({
        attempts: [
          failedOn("2026-11-04", "orders"),
          failedOn("2026-11-03", "orders"),
          failedOn("2026-11-02", "orders"),
        ],
        lastSyncAt: "2026-11-01T07:13:00.000Z",
        now: NOW,
        savedPassword: true,
        state: null,
      }),
    ).toEqual([
      {
        remedy: { kind: "conexiones", label: "Ver la conexión →" },
        text: "El conector falla al leer las órdenes desde hace 3 días. Las posiciones sí se leen; las operaciones nuevas pueden faltar.",
        tone: "warn",
      },
    ]);
  });

  test("failing on the positions: the figures stay at the last good sync, as data health says it", () => {
    expect(
      myInvestorHealthEntries({
        attempts: [
          failedOn("2026-11-04", "positions"),
          failedOn("2026-11-03", "positions"),
          failedOn("2026-11-02", "positions"),
        ],
        lastSyncAt: "2026-11-01T07:13:00.000Z",
        now: NOW,
        savedPassword: true,
        state: null,
      }).map((entry) => entry.text),
    ).toEqual([
      "El conector falla al leer las posiciones desde hace 3 días. Las cifras siguen en la última sincronización buena.",
    ]);
  });

  test("45 days with no password: the soft reminder", () => {
    expect(
      myInvestorHealthEntries({
        attempts: [],
        lastSyncAt: "2026-09-20T18:02:00.000Z",
        now: NOW,
        savedPassword: false,
        state: null,
      }),
    ).toEqual([
      {
        remedy: { kind: "conexiones", label: "Ver la conexión →" },
        text: "Llevas 45 días sin poner al día MyInvestor. Sin la contraseña guardada, solo se pone al día cuando pulsas.",
        tone: "warn",
      },
    ]);
  });

  test("a stop is the standing's to say, once: the reminder does not repeat it", () => {
    expect(
      myInvestorHealthEntries({
        attempts: [],
        lastSyncAt: "2026-07-01T18:02:00.000Z",
        now: NOW,
        savedPassword: false,
        state: {
          lastOutcomeJson: serializeMyInvestorSyncOutcome({
            at: NOW,
            forgotten: true,
            kind: "password_rejected",
          }),
          lease: null,
          pausedUntil: null,
          stoppedReason: null,
        },
      }),
    ).toEqual([]);
  });
});

describe("the units that do not square", () => {
  test("both figures and the difference with its sign; no adjustment promised", () => {
    expect(
      myInvestorUnitsLine({
        assetId: "a",
        bookUnits: "401.77",
        difference: "0.33",
        productKey: "k",
        sourceUnits: "402.1",
      }),
    ).toBe(
      "Las participaciones no cuadran: el libro dice 401,77 y MyInvestor 402,1 (+0,33). Las operaciones nuevas están aplicadas; worthline no crea ningún ajuste.",
    );
  });
});

describe("the result of a pass", () => {
  test("a good pass is the green notice, with what it brought", () => {
    expect(
      myInvestorResultView(
        {
          outcome: { applied: 2, at: NOW, kind: "ok", mismatches: 0, resynced: false },
          status: "done",
          waited: false,
        },
        NOW,
      ),
    ).toEqual({ blockedLine: null, text: "Al día: 2 operaciones nuevas.", tone: "ok" });
  });

  test("a waited pass says it waited", () => {
    expect(
      myInvestorResultView(
        {
          outcome: { applied: 1, at: NOW, kind: "ok", mismatches: 0, resynced: false },
          status: "done",
          waited: true,
        },
        NOW,
      ).text,
    ).toBe(
      "Al día: 1 operación nueva. Ya se estaba poniendo al día y has esperado a que terminara.",
    );
  });

  test("a mismatch warns, and points at the band", () => {
    expect(
      myInvestorResultView(
        {
          outcome: { applied: 0, at: NOW, kind: "ok", mismatches: 1, resynced: false },
          status: "done",
          waited: false,
        },
        NOW,
      ),
    ).toMatchObject({ tone: "warn" });
  });

  test("a refused pass says when the button comes back", () => {
    expect(
      myInvestorResultView(
        {
          reason: "rejected_no_reason",
          status: "blocked",
          until: "2026-11-05T11:04:00.000Z",
        },
        NOW,
      ).blockedLine,
    ).toBe("«Poner al día» vuelve mañana a las 12:04.");
  });
});

describe("when, in Madrid", () => {
  test("the last good sync: today, yesterday, a date, or never", () => {
    expect(formatMyInvestorLastGood("2026-11-04T06:12:00.000Z", NOW)).toBe("hoy, 07:12");
    expect(formatMyInvestorLastGood("2026-11-03T06:12:00.000Z", NOW)).toBe("ayer, 07:12");
    expect(formatMyInvestorLastGood("2026-11-01T06:12:00.000Z", NOW)).toBe(
      "el 1 de noviembre, 07:12",
    );
    expect(formatMyInvestorLastGood(null, NOW)).toBe("Nunca");
  });

  test("the last pass is said to a panel that did not see it", () => {
    expect(
      standing({
        outcome: { applied: 2, at: NOW, kind: "ok", mismatches: 0, resynced: false },
      }).lastLine,
    ).toBe("Al día: 2 operaciones nuevas.");
  });

  test("today, tomorrow, or a date", () => {
    expect(formatMyInvestorWhen("2026-11-04T16:30:00.000Z", NOW)).toBe("hoy a las 17:30");
    expect(formatMyInvestorWhen("2026-11-05T08:00:00.000Z", NOW)).toBe(
      "mañana a las 09:00",
    );
    expect(formatMyInvestorWhen("2026-11-09T08:00:00.000Z", NOW)).toBe(
      "el 9 de noviembre a las 09:00",
    );
  });
});

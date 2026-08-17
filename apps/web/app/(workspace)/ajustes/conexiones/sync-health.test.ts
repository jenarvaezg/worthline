import type { SyncRun } from "@worthline/db";
import { describe, expect, test } from "vitest";
import {
  describeRunOutcome,
  describeSyncError,
  describeSyncState,
  describeTrigger,
  runInstantOf,
  summarizeSyncHealth,
} from "./sync-health";

function run(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    createdAt: "2026-08-17T09:00:00.000Z",
    error: null,
    finishedAt: "2026-08-17T09:00:04.000Z",
    id: "run_1",
    sourceId: "src_binance",
    startedAt: "2026-08-17T09:00:00.000Z",
    status: "ok",
    trigger: "cron",
    ...overrides,
  };
}

describe("summarizeSyncHealth (#1224)", () => {
  test("una fuente sin corridas retenidas no inventa salud: solo sabemos que está conectada", () => {
    expect(summarizeSyncHealth([])).toEqual({
      at: null,
      errorMessage: null,
      state: "unknown",
      trigger: null,
    });
  });

  test("la corrida más reciente es la que manda, y llega primera del store", () => {
    const health = summarizeSyncHealth([
      run({ createdAt: "2026-08-17T09:00:00.000Z", id: "nueva", trigger: "manual" }),
      run({ createdAt: "2026-08-16T09:00:00.000Z", id: "vieja", status: "error" }),
    ]);

    expect(health.state).toBe("ok");
    expect(health.trigger).toBe("manual");
    expect(health.errorMessage).toBeNull();
  });

  test("una corrida fallida trae el motivo en lenguaje de usuario", () => {
    const health = summarizeSyncHealth([
      run({
        error: {
          code: "sync_persist_failed",
          message: "SQLITE_BUSY: database is locked at libsql://wl-abc123.turso.io",
          retriable: true,
        },
        status: "error",
      }),
    ]);

    expect(health.state).toBe("error");
    expect(health.errorMessage).toContain("no pudo guardarlos");
  });

  test("una corrida fallida NUNCA filtra el mensaje crudo del error", () => {
    const health = summarizeSyncHealth([
      run({
        error: {
          code: "sync_persist_failed",
          message: "connect ETIMEDOUT libsql://wl-abc123.turso.io token=eyJhbGci",
          retriable: true,
        },
        status: "error",
      }),
    ]);

    expect(health.errorMessage).not.toContain("libsql");
    expect(health.errorMessage).not.toContain("eyJhbGci");
    expect(health.errorMessage).not.toContain("ETIMEDOUT");
  });

  test("pending y running son la misma cosa para quien mira: hay un sync en curso", () => {
    for (const status of ["pending", "running"] as const) {
      expect(summarizeSyncHealth([run({ finishedAt: null, status })]).state).toBe(
        "running",
      );
    }
  });

  test("el instante de la corrida es su cierre; si sigue en curso, su arranque", () => {
    expect(summarizeSyncHealth([run()]).at).toBe("2026-08-17T09:00:04.000Z");
    expect(summarizeSyncHealth([run({ finishedAt: null, status: "running" })]).at).toBe(
      "2026-08-17T09:00:00.000Z",
    );
  });
});

describe("describeSyncError (#1224)", () => {
  test("un código conocido se traduce a una frase que dice qué hacer", () => {
    const message = describeSyncError({
      code: "sync_persist_failed",
      message: "boom",
      retriable: true,
    });

    expect(message).toContain("Vuelve a sincronizar");
    expect(message).not.toContain("boom");
  });

  test("un código que esta pantalla no conoce se cita como referencia, no se traga", () => {
    const message = describeSyncError({
      code: "sync_provider_rejected_key",
      message: "401 Unauthorized",
      retriable: false,
    });

    expect(message).toContain("sync_provider_rejected_key");
    expect(message).not.toContain("401");
  });

  test("un código que no parece un código nuestro no se imprime", () => {
    const message = describeSyncError({
      code: '<script>alert("x")</script>',
      message: "boom",
      retriable: false,
    });

    expect(message).not.toContain("script");
    expect(message).not.toContain("boom");
  });

  test("un error sin estructura sigue diciendo algo útil", () => {
    expect(describeSyncError(null)).toContain("falló");
  });
});

describe("vocabulario de una corrida (#1224)", () => {
  test("cada trigger tiene su palabra, y ninguna es el identificador crudo", () => {
    expect(describeTrigger("cron")).toBe("Automática");
    expect(describeTrigger("manual")).toBe("Manual");
    expect(describeTrigger("connect")).toBe("Al conectar");
  });

  test("el resultado de una corrida se lee sin saber inglés", () => {
    expect(describeRunOutcome("ok")).toBe("Correcta");
    expect(describeRunOutcome("error")).toBe("Con error");
    expect(describeRunOutcome("pending")).toBe("En curso");
    expect(describeRunOutcome("running")).toBe("En curso");
  });

  test("el estado lleva SIEMPRE su palabra, para que el color no sea la única señal", () => {
    for (const state of ["ok", "error", "running", "unknown"] as const) {
      expect(describeSyncState(state).label.length).toBeGreaterThan(0);
    }
    expect(describeSyncState("error").toneClass).toBe("isError");
    expect(describeSyncState("running").toneClass).toBe("isPending");
    expect(describeSyncState("unknown").toneClass).toBe("isUnknown");
    // El verde del punto es el estado base del pill: la corrida buena no añade clase.
    expect(describeSyncState("ok").toneClass).toBe("");
  });

  test("una corrida en curso se fecha por su arranque; una cerrada, por su cierre", () => {
    expect(runInstantOf(run())).toBe("2026-08-17T09:00:04.000Z");
    expect(runInstantOf(run({ finishedAt: null, status: "running" }))).toBe(
      "2026-08-17T09:00:00.000Z",
    );
    // Ni arranque ni cierre (una corrida abierta a medias): queda su creación.
    expect(
      runInstantOf(
        run({ createdAt: "2026-08-01T00:00:00.000Z", finishedAt: null, startedAt: null }),
      ),
    ).toBe("2026-08-01T00:00:00.000Z");
  });
});

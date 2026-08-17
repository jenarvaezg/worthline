import { type SyncRun, syncRunInstant } from "@worthline/db";
import { describe, expect, test } from "vitest";
import {
  describeRunOutcome,
  describeSyncError,
  describeSyncState,
  describeTrigger,
  summarizeSyncHealth,
} from "./sync-health";
import {
  failedSyncRun as failedRun,
  sourceFreshness as freshness,
  syncRun as run,
} from "./sync-run-fixtures";

/** El caso corriente: la fuente sincroniza y su frescura está al día. */
function healthy(runs: readonly SyncRun[]) {
  return summarizeSyncHealth({
    freshness: freshness("fresh"),
    lastSyncAt: "2026-08-17T09:00:04.000Z",
    runs,
  });
}

describe("summarizeSyncHealth (#1224)", () => {
  test("una fuente sin corridas ni frescura no inventa salud: solo sabemos que está conectada", () => {
    expect(summarizeSyncHealth({ freshness: null, lastSyncAt: null, runs: [] })).toEqual({
      at: null,
      errorMessage: null,
      state: "unknown",
      trigger: null,
    });
  });

  test("la corrida más reciente es la que manda, y llega primera del store", () => {
    const health = healthy([
      run({ createdAt: "2026-08-17T09:00:00.000Z", id: "nueva", trigger: "manual" }),
      failedRun({ createdAt: "2026-08-16T09:00:00.000Z", id: "vieja" }),
    ]);

    expect(health.state).toBe("ok");
    expect(health.trigger).toBe("manual");
    // Un fallo YA SUPERADO no se resucita: la corrida buena de después lo cierra.
    expect(health.errorMessage).toBeNull();
  });

  test("una corrida fallida trae el motivo en lenguaje de usuario", () => {
    const health = healthy([failedRun()]);

    expect(health.state).toBe("error");
    expect(health.errorMessage).toContain("no pudo guardarlos");
  });

  test("una corrida fallida NUNCA filtra el mensaje crudo del error", () => {
    const health = healthy([
      failedRun({
        error: {
          code: "sync_persist_failed",
          message: "connect ETIMEDOUT libsql://wl-abc123.turso.io token=eyJhbGci",
          retriable: true,
        },
      }),
    ]);

    expect(health.errorMessage).not.toContain("libsql");
    expect(health.errorMessage).not.toContain("eyJhbGci");
    expect(health.errorMessage).not.toContain("ETIMEDOUT");
  });

  test("pending y running son la misma cosa para quien mira: hay un sync en curso", () => {
    for (const status of ["pending", "running"] as const) {
      expect(healthy([run({ finishedAt: null, status })]).state).toBe("running");
    }
  });

  test("un reintento en vuelo NO borra de pantalla el motivo del fallo anterior", () => {
    // Es justo la respuesta que esta pantalla existe para dar: si un reintento la
    // tapara, quien entra a preguntar «¿por qué no se actualiza?» se va sin ella.
    const health = healthy([
      run({ finishedAt: null, id: "reintento", status: "running" }),
      failedRun({ createdAt: "2026-08-17T08:00:00.000Z", id: "fallida" }),
    ]);

    expect(health.state).toBe("running");
    expect(health.errorMessage).toContain("no pudo guardarlos");
  });

  test("el instante de la corrida es su cierre; si sigue en curso, su arranque", () => {
    expect(healthy([run()]).at).toBe("2026-08-17T09:00:04.000Z");
    expect(healthy([run({ finishedAt: null, status: "running" })]).at).toBe(
      "2026-08-17T09:00:00.000Z",
    );
  });
});

describe("un fetch roto que no deja corrida (#1224)", () => {
  // El fallo canónico —credenciales revocadas, proveedor caído— se captura AGUAS
  // ARRIBA: nunca abre corrida, así que `sync_run` solo guarda la última corrida
  // BUENA. Sin mirar la frescura de la fuente, la fila heredaría ese verde y
  // AFIRMARÍA salud mientras la fuente lleva días a oscuras.
  test("la fuente marcada como fallida se lee con error aunque su última corrida fuese buena", () => {
    const health = summarizeSyncHealth({
      freshness: freshness("failed"),
      lastSyncAt: "2026-08-14T09:00:04.000Z",
      runs: [run()],
    });

    expect(health.state).toBe("error");
    expect(health.errorMessage).toContain("no consiguió traer");
    expect(health.errorMessage).toContain("credenciales");
  });

  test("y se fecha por el intento de traída, no por la última corrida buena", () => {
    const health = summarizeSyncHealth({
      freshness: freshness("failed", "2026-08-17T21:00:00.000Z"),
      lastSyncAt: "2026-08-14T09:00:04.000Z",
      runs: [run({ finishedAt: "2026-08-14T09:00:04.000Z" })],
    });

    // Fechar el fallo con el cierre de la corrida BUENA sería decir que falló el
    // día que funcionó.
    expect(health.at).toBe("2026-08-17T21:00:00.000Z");
  });

  test("una fuente rancia no es una fuente roja: se dice desactualizada", () => {
    const health = summarizeSyncHealth({
      freshness: freshness("stale"),
      lastSyncAt: "2026-08-14T09:00:04.000Z",
      runs: [run()],
    });

    expect(health.state).toBe("stale");
    expect(health.errorMessage).toBeNull();
  });

  test("un fallo de la corrida manda sobre el «rancio» de la frescura", () => {
    const health = summarizeSyncHealth({
      freshness: freshness("stale"),
      lastSyncAt: "2026-08-14T09:00:04.000Z",
      runs: [failedRun()],
    });

    expect(health.state).toBe("error");
    expect(health.errorMessage).toContain("no pudo guardarlos");
  });

  test("un sync en vuelo se anuncia como tal, incluso sobre una fuente marcada fallida", () => {
    const health = summarizeSyncHealth({
      freshness: freshness("failed"),
      lastSyncAt: "2026-08-14T09:00:04.000Z",
      runs: [run({ finishedAt: null, status: "running" })],
    });

    // La palabra dice lo que pasa AHORA; el motivo del fallo sigue debajo.
    expect(health.state).toBe("running");
    expect(health.errorMessage).toContain("no consiguió traer");
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
    for (const state of ["ok", "error", "running", "stale", "unknown"] as const) {
      expect(describeSyncState(state).label.length).toBeGreaterThan(0);
    }
    expect(describeSyncState("error").tone).toBe("error");
    expect(describeSyncState("running").tone).toBe("pending");
    expect(describeSyncState("ok").tone).toBe("ok");
    // Rancia y sin-noticias comparten tono: en ninguna de las dos hay señal viva
    // que justifique el verde, y ninguna es un fallo.
    expect(describeSyncState("stale").tone).toBe("muted");
    expect(describeSyncState("unknown").tone).toBe("muted");
  });

  test("una corrida en curso se fecha por su arranque; una cerrada, por su cierre", () => {
    expect(syncRunInstant(run())).toBe("2026-08-17T09:00:04.000Z");
    expect(syncRunInstant(run({ finishedAt: null, status: "running" }))).toBe(
      "2026-08-17T09:00:00.000Z",
    );
    // Ni arranque ni cierre (una corrida abierta a medias): queda su creación.
    expect(
      syncRunInstant(
        run({ createdAt: "2026-08-01T00:00:00.000Z", finishedAt: null, startedAt: null }),
      ),
    ).toBe("2026-08-01T00:00:00.000Z");
  });
});

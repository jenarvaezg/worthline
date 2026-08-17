import type { SyncRun } from "@worthline/db";
import type { SourceFreshnessRow } from "./sync-health";

/**
 * Las corridas y la frescura de mentira que comparten los tests de esta carpeta
 * (#1224). Una sola factory: cuando `SyncRun` gane un campo, se añade aquí y no en
 * tres literales que se van desincronizando.
 *
 * `page.test.tsx` NO puede usarla: sus dobles viven en `vi.hoisted`, que se eleva
 * por encima de los imports, así que allí el literal es obligado.
 */

/** Una corrida correcta, disparada por el cron. */
export function syncRun(overrides: Partial<SyncRun> = {}): SyncRun {
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

/**
 * Una corrida que reventó al guardar — el único fallo que hoy puede llegar a
 * `sync_run` — con un `message` crudo que incluye a propósito lo que NUNCA debe
 * salir a pantalla (driver, URL de la base): así el test que lo vigila tiene algo
 * real que buscar.
 */
export function failedSyncRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return syncRun({
    error: {
      code: "sync_persist_failed",
      message: "SQLITE_BUSY: database is locked at libsql://wl-abc123.turso.io",
      retriable: true,
    },
    status: "error",
    ...overrides,
  });
}

/** Una fila de frescura de fuente en el estado que se quiera probar. */
export function sourceFreshness(
  freshnessState: SourceFreshnessRow["freshnessState"],
  fetchedAt = "2026-08-17T21:00:00.000Z",
): SourceFreshnessRow {
  return { fetchedAt, freshnessState };
}

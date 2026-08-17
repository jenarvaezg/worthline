import type { SyncRun, SyncRunError, SyncRunStatus, SyncTrigger } from "@worthline/db";

/**
 * La salud de sync, en lenguaje de usuario (#1224, PRD #1222 S2).
 *
 * `sync_run` ya persiste desde #885 cómo fue cada intento; la página solo pintaba
 * `last_sync_at`, así que un sync que falla era INVISIBLE: la cifra se quedaba
 * quieta y nadie sabía por qué. Este módulo es la traducción — de la fila cruda a
 * la palabra que responde «¿por qué no se actualiza esto?» — y vive aparte del JSX
 * para poder fijarla con tests sin renderizar nada.
 *
 * Regla dura del módulo: el `message` crudo del error NUNCA se imprime. Viene de
 * un `catch` (mensaje de driver, URL de la base, a veces un token en la cadena de
 * conexión) y su sitio es el log del servidor, no la pantalla. Lo que se traduce
 * es el `code`, que sí es nuestro vocabulario.
 */

/** Cómo se lee la última corrida. `unknown` = conectada, sin corridas retenidas. */
export type SyncHealthState = "ok" | "error" | "running" | "unknown";

export interface SyncHealth {
  state: SyncHealthState;
  /** Qué disparó la última corrida, o null si no hay ninguna. */
  trigger: SyncTrigger | null;
  /** El instante de la última corrida (ISO), o null si no hay ninguna. */
  at: string | null;
  /** El motivo comprensible; solo cuando `state === "error"`. */
  errorMessage: string | null;
}

/**
 * El catálogo de motivos, por `code`. Solo entra aquí un código que puede llegar
 * a `sync_run.error_json`, y hoy eso es exactamente uno: el executor de
 * `source-sync` abre la corrida DESPUÉS del fetch, así que lo único que puede
 * fallar dentro es el persist/ripple (`connected-source-seams.ts`). Los códigos de
 * la cola (`source_sync_open_failed`, `sync_job_handler_threw`…) mueren en el job:
 * ninguna corrida se abrió, así que no hay fila que traducir. Un código nuevo cae
 * en el respaldo de abajo, que lo cita en vez de tragárselo.
 */
const ERROR_COPY: Record<string, string> = {
  sync_persist_failed:
    "worthline recibió los datos de la fuente pero no pudo guardarlos, así que las cifras siguen en la última sincronización buena. Vuelve a sincronizar; si sigue fallando, es cosa nuestra.",
};

/** La forma de un código nuestro. Lo que no encaja no se imprime. */
const CODE_SHAPE = /^[a-z0-9][a-z0-9_.:-]{0,47}$/i;

/**
 * El motivo de una corrida fallida, en una frase. Traduce por `code` y, si no lo
 * conoce, cita el código como referencia para soporte — un código es vocabulario
 * nuestro, no dato del usuario, pero se valida contra {@link CODE_SHAPE} antes de
 * pintarlo: lo que llega de la columna JSON se trata como entrada, no como
 * literal de nuestro fuente.
 */
export function describeSyncError(error: SyncRunError | null): string {
  const known = error ? ERROR_COPY[error.code] : undefined;
  if (known) return known;

  const reference = error && CODE_SHAPE.test(error.code) ? error.code : null;

  return reference
    ? `La última sincronización falló por un motivo que esta pantalla no sabe traducir. Vuelve a intentarlo y, si sigue, cuéntanoslo citando «${reference}».`
    : "La última sincronización falló y no quedó registrado el motivo. Vuelve a intentarlo y, si sigue, cuéntanoslo.";
}

/**
 * Cuándo pasó una corrida: su cierre si terminó, su arranque si sigue en curso y,
 * si le falta ambos (una corrida abierta que nunca llegó a `running`), su
 * creación.
 */
export function runInstantOf(run: SyncRun): string | null {
  return run.finishedAt ?? run.startedAt ?? run.createdAt;
}

/**
 * La salud de una fuente a partir de sus corridas retenidas. El store las
 * entrega newest-first (`readRuns`), así que la primera es la última corrida.
 */
export function summarizeSyncHealth(runs: readonly SyncRun[]): SyncHealth {
  const latest = runs[0];
  if (!latest) {
    return { at: null, errorMessage: null, state: "unknown", trigger: null };
  }

  const state = healthStateOf(latest.status);

  return {
    at: runInstantOf(latest),
    errorMessage: state === "error" ? describeSyncError(latest.error) : null,
    state,
    trigger: latest.trigger,
  };
}

/** `pending` y `running` son lo mismo para quien mira: hay un sync en vuelo. */
function healthStateOf(status: SyncRunStatus): SyncHealthState {
  if (status === "ok" || status === "error") return status;
  return "running";
}

const TRIGGER_LABEL: Record<SyncTrigger, string> = {
  connect: "Al conectar",
  cron: "Automática",
  manual: "Manual",
};

/** Quién disparó la corrida, en una palabra. */
export function describeTrigger(trigger: SyncTrigger): string {
  return TRIGGER_LABEL[trigger];
}

/** Cómo acabó una corrida, para la columna «Resultado» del historial. */
export function describeRunOutcome(status: SyncRunStatus): string {
  if (status === "ok") return "Correcta";
  if (status === "error") return "Con error";
  return "En curso";
}

/**
 * La píldora de estado: su palabra y la clase de tono que le toca. La palabra va
 * SIEMPRE — el color del punto no puede ser la única señal (canon §8) — y el
 * estado bueno no añade clase: el verde es el punto base de `.coinStatusPill`.
 */
export function describeSyncState(state: SyncHealthState): {
  label: string;
  toneClass: string;
} {
  if (state === "error") return { label: "Con error", toneClass: "isError" };
  if (state === "running") return { label: "Sincronizando…", toneClass: "isPending" };
  // Conectada y sin corridas retenidas: sabemos que está, no cómo le fue.
  if (state === "unknown") return { label: "Conectado", toneClass: "isUnknown" };
  return { label: "Sincronizado", toneClass: "" };
}

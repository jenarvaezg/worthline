import type { SyncRun, SyncRunError, SyncRunStatus, SyncTrigger } from "@worthline/db";
import {
  type DataQualitySourceFreshness,
  sourceFreshnessStatus,
} from "@worthline/domain";

/**
 * La salud de sync, en lenguaje de usuario (#1224, PRD #1222 S2).
 *
 * `sync_run` ya persiste desde #885 cómo fue cada intento; la página solo pintaba
 * `last_sync_at`, así que un sync que falla era INVISIBLE: la cifra se quedaba
 * quieta y nadie sabía por qué. Este módulo es la traducción — de la fila cruda a
 * la palabra que responde «¿por qué no se actualiza esto?» — y vive aparte del JSX
 * para poder fijarla con tests sin renderizar nada.
 *
 * Lee DOS ejes, porque un fallo puede dejar huella en cualquiera de los dos:
 *
 * - `sync_run`, que cubre lo que revienta DENTRO de la corrida (el persist).
 * - la frescura de la fuente, que es la única huella de lo que revienta ANTES de
 *   abrirla: el fetch (credenciales revocadas, proveedor caído) se captura aguas
 *   arriba y no abre corrida ninguna. Mirando solo `sync_run`, la fila heredaría
 *   el verde de la última corrida buena y AFIRMARÍA salud con la fuente a
 *   oscuras — y contradiría al bloque de salud del home y al agente, que leen ese
 *   otro eje. La política de ese eje NO se reimplementa aquí: se llama a
 *   `sourceFreshnessStatus`, la misma que alimenta la colección compartida.
 *
 * Regla dura del módulo: el `message` crudo del error NUNCA se imprime. Viene de
 * un `catch` (mensaje de driver, URL de la base, a veces un token en la cadena de
 * conexión) y su sitio es el log del servidor, no la pantalla. Lo que se traduce
 * es el `code`, que sí es nuestro vocabulario.
 */

/** La fila de frescura de una fuente, tal como la da `readSourceFreshness`. */
export type SourceFreshnessRow = DataQualitySourceFreshness;

/** Cómo se lee la conexión. `unknown` = conectada, sin nada que contar todavía. */
export type SyncHealthState = "ok" | "error" | "running" | "stale" | "unknown";

/** El tono con el que se pinta un estado. El render lo traduce a su clase. */
export type SyncHealthTone = "ok" | "error" | "pending" | "muted";

export interface SyncHealth {
  state: SyncHealthState;
  /** Qué disparó la última corrida, o null si no hay ninguna. */
  trigger: SyncTrigger | null;
  /** El instante que la fila fecha: el del FALLO si hay fallo, y si no el de la última corrida. */
  at: string | null;
  /** El motivo comprensible; presente siempre que haya un fallo vivo. */
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

/**
 * El motivo cuando el fallo NO dejó corrida: reventó al traer los datos. No hay
 * `code` que traducir —nunca se abrió la fila— así que la frase nombra las dos
 * causas que lo explican casi siempre y lo que hay que hacer con cada una.
 */
const FETCH_FAILURE_COPY =
  "worthline no consiguió traer los datos de la fuente en su último intento: lo habitual es que las credenciales ya no valgan o que el proveedor esté caído. Las cifras siguen en la última sincronización buena. Revisa las credenciales y vuelve a sincronizar.";

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

/** El estado de la conexión que implica el estado de UNA corrida. */
const RUN_STATE: Record<SyncRunStatus, SyncHealthState> = {
  error: "error",
  ok: "ok",
  // `pending` y `running` son lo mismo para quien mira: hay un sync en vuelo.
  pending: "running",
  running: "running",
};

/**
 * La salud de una fuente: sus corridas retenidas (newest-first, como las entrega
 * `readRuns`) cruzadas con la frescura de la fuente.
 */
export function summarizeSyncHealth({
  freshness,
  lastSyncAt,
  runs,
}: {
  freshness: SourceFreshnessRow | null;
  /** `connected_sources.last_sync_at` — parte de la política de frescura compartida. */
  lastSyncAt: string | null;
  runs: readonly SyncRun[];
}): SyncHealth {
  const latest = runs[0];
  // La corrida TERMINAL más reciente: la que de verdad dice cómo acabó lo último.
  // Un reintento en vuelo por delante no borra su veredicto — si lo borrase, quien
  // entra a preguntar por qué no se actualiza algo se iría sin la respuesta.
  const latestTerminal = runs.find(
    (run) => run.status === "ok" || run.status === "error",
  );
  const failedRun = latestTerminal?.status === "error" ? latestTerminal : null;

  const freshnessStatus = sourceFreshnessStatus({ lastSyncAt }, freshness);
  const fetchFailed = freshnessStatus === "failed";
  const failure = failedRun ?? (fetchFailed ? "fetch" : null);
  const inFlight = latest !== undefined && RUN_STATE[latest.status] === "running";

  return {
    at: instantOf({ failedRun, fetchFailed, freshness, latest }),
    errorMessage:
      failure === null
        ? null
        : failure === "fetch"
          ? FETCH_FAILURE_COPY
          : describeSyncError(failure.error),
    state: stateOf({ failure, freshnessStatus, inFlight, latest }),
    trigger: latest?.trigger ?? null,
  };
}

/**
 * La palabra que se lleva la píldora. Un sync en vuelo manda —es lo que está
 * pasando AHORA, y el motivo del fallo sigue escrito debajo—; después, cualquier
 * fallo vivo; después, el «rancio» de la frescura; y solo si nada de eso, el
 * veredicto de la última corrida.
 */
function stateOf({
  failure,
  freshnessStatus,
  inFlight,
  latest,
}: {
  failure: SyncRun | "fetch" | null;
  freshnessStatus: "failed" | "stale" | null;
  inFlight: boolean;
  latest: SyncRun | undefined;
}): SyncHealthState {
  if (inFlight) return "running";
  if (failure !== null) return "error";
  if (freshnessStatus === "stale") return "stale";
  return latest ? RUN_STATE[latest.status] : "unknown";
}

/**
 * Qué instante fecha la fila. Cuando el fallo es de FETCH, la fecha es la del
 * intento de traída: fecharlo con el cierre de la última corrida sería decir que
 * falló el día que funcionó.
 */
function instantOf({
  failedRun,
  fetchFailed,
  freshness,
  latest,
}: {
  failedRun: SyncRun | null;
  fetchFailed: boolean;
  freshness: SourceFreshnessRow | null;
  latest: SyncRun | undefined;
}): string | null {
  if (failedRun) return runInstantOf(failedRun);
  if (fetchFailed && freshness) return freshness.fetchedAt;
  return latest ? runInstantOf(latest) : null;
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

const RUN_OUTCOME_LABEL: Record<SyncRunStatus, string> = {
  error: "Con error",
  ok: "Correcta",
  pending: "En curso",
  running: "En curso",
};

/** Cómo acabó una corrida, para la columna «Resultado» del historial. */
export function describeRunOutcome(status: SyncRunStatus): string {
  return RUN_OUTCOME_LABEL[status];
}

/**
 * La palabra y el tono de cada estado. La palabra va SIEMPRE — el color del punto
 * no puede ser la única señal (canon §8) — y el tono es semántico, no una clase
 * CSS: quién pinta decide con qué clase se dibuja.
 */
const STATE_PRESENTATION: Record<
  SyncHealthState,
  { label: string; tone: SyncHealthTone }
> = {
  error: { label: "Con error", tone: "error" },
  ok: { label: "Sincronizado", tone: "ok" },
  running: { label: "Sincronizando…", tone: "pending" },
  // Rancia y sin-noticias comparten tono: en ninguna hay señal viva que justifique
  // el verde, y ninguna es un fallo.
  stale: { label: "Desactualizado", tone: "muted" },
  unknown: { label: "Conectado", tone: "muted" },
};

export function describeSyncState(state: SyncHealthState): {
  label: string;
  tone: SyncHealthTone;
} {
  return STATE_PRESENTATION[state];
}

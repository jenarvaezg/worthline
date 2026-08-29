/**
 * Una conexión cuyo sync falla intento tras intento (#1226, PRD #1222 S4).
 *
 * Vive en la familia `source_freshness` a propósito: el objeto afectado es el
 * mismo (la fuente), la superficie donde se repara es la misma
 * (`/ajustes/conexiones`) y la pregunta que responde es la misma familia de
 * pregunta que `FAILED_SOURCE_SYNC` — «¿por qué no se mueve esto?». Lo que añade es
 * el eje que la frescura no tiene: la CUENTA.
 */

import {
  type DataQualityCollector,
  type DataQualitySignal,
  dateOnly,
  signalNaturalKey,
} from "./data-quality-collector";
import {
  type DataQualitySourceHealthInput,
  sourceFreshnessStatus,
  sourceIsInScope,
} from "./data-quality-connected-source";

/** Machine code for a connection whose sync keeps failing attempt after attempt (#1226). */
export const PERSISTENT_SYNC_FAILURE_CODE = "PERSISTENT_SYNC_FAILURE";

/**
 * Cuántos intentos terminales en error SEGUIDOS hacen que un sync sea
 * «persistente» (#1226) — el umbral que el PRD #1222 dejaba a la implementación.
 *
 * Dos, contados desde el más reciente. Uno solo no basta: un fallo aislado es un
 * proveedor que tosió o un error marcado `retriable`, y la página de conexiones ya
 * lo cuenta sin necesidad de alertar a nadie. Dos seguidos ya no se arreglan solos.
 * Con el cron dos veces al día eso son como mucho ~12 h hasta que la cifra
 * congelada deja de estar congelada en silencio — pronto para que no se podra,
 * tarde para que un hipo no dé la lata.
 *
 * `retriable` NO entra en la regla, aunque `SyncRunError` lo lleve: hoy TODO fallo
 * que llega a `sync_run` se marca retriable (el fetch se captura aguas arriba y no
 * abre corrida), así que una rama por no-retriable sería código muerto que promete
 * una política que nadie ejerce.
 */
export const PERSISTENT_SYNC_FAILURE_THRESHOLD = 2;

/**
 * Un intento de sync tal como la salud de datos lo lee (#1226): en qué acabó y
 * cuándo. Es la proyección de una fila de `sync_run` — no una traducción: los
 * mismos cuatro estados, el instante ya resuelto por quien tiene la fila delante.
 * El motivo del fallo NO viaja: su `message` viene de un `catch` (mensaje de
 * driver, a veces un token en la cadena de conexión) y su sitio es el log del
 * servidor, así que la señal habla de cuántos intentos fallaron y remite a la
 * página, que es donde el `code` se traduce.
 */
export interface DataQualitySyncAttempt {
  /** `pending`/`running` son no terminales: un intento en vuelo aún no dice nada. */
  status: "pending" | "running" | "ok" | "error";
  /** El instante que fecha el intento, o null si la fila no fechó ninguno. */
  at: string | null;
}

export interface DataQualityPersistentSyncFailureInput
  extends DataQualitySourceHealthInput {
  /**
   * Los intentos de sync retenidos por fuente, NEWEST-FIRST (#1226) — el eje que
   * cuenta cuántas veces seguidas ha fallado algo, que la frescura no sabe contar.
   * Requerido, no opcional, por la misma razón que `netUnitsByAssetId`: una alerta
   * que solo uno de los dos consumidores alimenta es una alerta sobre la que el
   * humano y el agente se contradicen. Un mapa vacío es la lectura honesta de «esta
   * fuente no ha intentado nada todavía».
   */
  syncAttemptsBySourceId: ReadonlyMap<string, readonly DataQualitySyncAttempt[]>;
}

/**
 * DONDE ESTA SEÑAL SE APARTA DE LA PROSA DE #1226: el issue la clasificaba como
 * «una señal que NO toca la cifra de hoy», remitiendo al filtro que aparta del home
 * lo que solo afecta a proyecciones o al histórico (`NON_FIGURE_CATEGORIES`), y esa
 * lectura la habría dejado únicamente en la superficie del agente. No cabe con sus
 * propios criterios de aceptación, que piden «alerta visible en las superficies de
 * data-health CON LINK a la página» y que la exposición agent/MCP sea un «también»:
 * el contrato del agente no lleva `href`, así que fuera del home no queda ninguna
 * superficie que cumpla lo primero. Y la premisa tampoco se sostiene: la cifra de
 * hoy no está intacta, está CONGELADA — es el número de hace días presentándose
 * como el de hoy, que es exactamente lo que el bloque del home existe para avisar.
 * Así que hereda el tratamiento de la familia `source_freshness`: llega al home,
 * como su hermana de fetch.
 *
 * `high`, como el fallo de fetch, por lo mismo. `fixable: false` porque lo que puede
 * fallar DENTRO de una corrida es nuestro guardado, no un dato que el usuario pueda
 * corregir; la frase, por eso, no le manda hacer nada y remite a la página, que es
 * donde el motivo se explica.
 *
 * Con `STALE_SOURCE_SYNC` (medium) conviven a propósito: un persist que falla no
 * mueve `last_sync_at`, así que la frescura se enrancia por detrás, y son dos
 * lecturas verdaderas y distintas («lleva días sin moverse» y «lo ha intentado N
 * veces sin conseguirlo») que juntas dicen más. En el home no hacen ruido: el bloque
 * se queda solo con el tramo de severidad más alta, y esta es `high`.
 *
 * Con `FAILED_SOURCE_SYNC` (high) NO conviven, y por eso esta cede: si el fetch está
 * roto AHORA, esa es la causa viva, y las corridas en error que quedan detrás son la
 * avería anterior de la misma conexión. Dos líneas rojas sobre Binance ocupando dos
 * de los tres huecos del bloque serían un signo repetido sobre una sola cosa que
 * hacer, y la colección se levanta «una señal por cosa que el usuario haría». No se
 * pierde aviso: la de fetch es igual de `high` y apunta al mismo sitio.
 *
 * La cuenta va en la frase (no «falla mucho», sino cuántas veces) y siempre es ≥ 2
 * por el umbral, así que el plural nunca tiene que ramificar.
 */
export const collectPersistentSyncFailureSignals: DataQualityCollector<
  DataQualityPersistentSyncFailureInput
> = (input) => {
  const signals: DataQualitySignal[] = [];

  for (const source of input.connectedSources) {
    if (!sourceIsInScope(source, input.ownedAssetIds)) {
      continue;
    }

    const freshness = input.sourceFreshnessBySourceId.get(source.id) ?? null;
    if (sourceFreshnessStatus(source, freshness) === "failed") {
      continue;
    }

    const { count, latestFailureAt } = consecutiveFailures(
      input.syncAttemptsBySourceId.get(source.id) ?? [],
    );
    if (count < PERSISTENT_SYNC_FAILURE_THRESHOLD) {
      continue;
    }

    signals.push({
      affected: {
        id: source.id,
        label: source.label,
        object: "connected_source",
      },
      category: "source_freshness",
      code: PERSISTENT_SYNC_FAILURE_CODE,
      fixable: false,
      label:
        `Las últimas ${count} sincronizaciones de "${source.label}" fallaron: sus cifras ` +
        "siguen congeladas en la última que funcionó.",
      naturalKey: signalNaturalKey(
        "source_freshness",
        PERSISTENT_SYNC_FAILURE_CODE,
        source.id,
      ),
      ...(latestFailureAt === null ? {} : { observedDate: dateOnly(latestFailureAt) }),
      severity: "high",
    });
  }

  return signals;
};

/**
 * Cuántos intentos han fallado SEGUIDOS, contando desde el más reciente (#1226).
 *
 * Los intentos no terminales se saltan en vez de cortar la racha: un reintento en
 * vuelo por delante no borra el veredicto de lo anterior — si lo borrase, la alerta
 * desaparecería justo mientras se reintenta y volvería al fallar, parpadeando. Es la
 * misma lectura que hace la píldora de la página con la «corrida terminal más
 * reciente» (#1224). El primer `ok` cierra la racha: ahí el sync volvió a funcionar.
 */
function consecutiveFailures(attempts: readonly DataQualitySyncAttempt[]): {
  count: number;
  latestFailureAt: string | null;
} {
  let count = 0;
  let latestFailureAt: string | null = null;

  for (const attempt of attempts) {
    if (attempt.status === "pending" || attempt.status === "running") {
      continue;
    }
    if (attempt.status === "ok") {
      break;
    }
    // La fecha es la del fallo MÁS RECIENTE, sea la que sea — incluido un `null`.
    // Con `??=` un intento reciente sin instante cedía la fecha a uno más viejo que
    // sí lo tenía, y la señal decía «falló el día que aún funcionaba».
    if (count === 0) {
      latestFailureAt = attempt.at;
    }
    count += 1;
  }

  return { count, latestFailureAt };
}

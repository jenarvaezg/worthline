import { formatLastSync } from "@web/ajustes/numista-helpers";
import { PendingSubmit } from "@web/pending-submit";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import { Fragment } from "react";
import type { ConnectionDefinition } from "./connection-registry";
import type { ConnectionRow } from "./connection-rows";
import {
  describeRunOutcome,
  describeSyncState,
  describeTrigger,
  runInstantOf,
  summarizeSyncHealth,
} from "./sync-health";

/**
 * El libro de conexiones (#1223, PRD #1222) — la disposición que salió del
 * prototipo (rama `prototipo/1223-conexiones`, variante A): una FILA por
 * conexión con lo que se sabe de un vistazo, y bajo esa misma fila el pliegue
 * con lo que se puede hacer. Nada obliga a navegar para actuar.
 *
 * Bajo la fila cuelgan, en ese orden: el motivo de un sync fallido (visible sin
 * abrir nada), el pliegue del historial de corridas (S2 #1224) y el de
 * desconexión. La edición de credenciales (S3 #1225) entra ahí sin mover la fila.
 *
 * Cero JSX por fuente: todo lo que distingue a un adapter de otro llega en su
 * entrada del registry.
 */

export interface ConnectionEntry {
  definition: ConnectionDefinition;
  row: ConnectionRow;
}

export default function ConnectionsTable({
  connections,
  currentUrl,
  errorFormId,
  privacyMode,
}: {
  connections: ConnectionEntry[];
  currentUrl: string;
  /** El `formId` del error que traiga la URL, o null si no trae ninguno. */
  errorFormId: string | null;
  privacyMode: boolean;
}) {
  const connected = connections.filter((entry) => entry.row.source !== null);
  const available = connections.filter((entry) => entry.row.source === null);

  return (
    <>
      {connected.length === 0 ? (
        <p className="emptyLine">
          No tienes ninguna fuente conectada. Conecta una abajo y worthline la
          sincronizará sola.
        </p>
      ) : (
        <div className="tableScroll">
          <table className="conexTable">
            <thead>
              <tr>
                <th>Fuente</th>
                <th>Estado</th>
                <th>Última sincronización</th>
                <th className="conexNum">Elementos</th>
                <th className="conexNum">Valor</th>
                <th aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              {connected.map(({ definition, row }) => {
                // Filtrada arriba: una conexión de esta lista SIEMPRE tiene fuente.
                const source = row.source!;
                // La salud sale de `sync_run`, no de `last_sync_at`: la columna
                // cacheada dice cuándo fue el último sync BUENO, y por sí sola no
                // distingue «todo en orden» de «lleva tres días fallando» (#1224).
                const health = summarizeSyncHealth(row.runs);
                const state = describeSyncState(health.state);

                return (
                  <Fragment key={definition.adapter}>
                    <tr>
                      <td>
                        <span className="conexName">{definition.label}</span>
                        <span className="conexSub">{definition.mirrors}</span>
                      </td>
                      <td>
                        <span className={`coinStatusPill ${state.toneClass}`.trim()}>
                          {state.label}
                        </span>
                        {health.trigger ? (
                          <span className="conexSub">
                            {describeTrigger(health.trigger)}
                          </span>
                        ) : null}
                      </td>
                      <td>{formatLastSync(source.lastSyncAt)}</td>
                      <td className="conexNum">
                        {row.unitCount}
                        <span className="conexSub">{definition.unitLabel}</span>
                      </td>
                      <td className="conexNum">
                        {formatMoneyMinorPrivacy(
                          { amountMinor: row.valueMinor, currency: "EUR" },
                          privacyMode,
                        )}
                      </td>
                      <td>
                        <span className="conexActions">
                          <form action={definition.syncAction} className="coinSyncForm">
                            <input name="currentUrl" type="hidden" value={currentUrl} />
                            <input name="sourceId" type="hidden" value={source.id} />
                            <PendingSubmit pendingLabel="Sincronizando…">
                              {definition.syncLabel}
                            </PendingSubmit>
                          </form>
                          {row.fichaHref ? (
                            <Link className="actionLink" href={row.fichaHref}>
                              {definition.viewLabel}
                            </Link>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                    <tr className="conexDetailRow">
                      <td colSpan={6}>
                        {/* El motivo del fallo va FUERA de todo pliegue: es la
                            respuesta a «¿por qué no se actualiza esto?», y esa
                            no se busca abriendo cosas (#1224). */}
                        {health.errorMessage ? (
                          <p className="conexSyncError">
                            {/* CUÁNDO falló, porque la columna «Última
                                sincronización» no lo dice: esa sigue clavada en
                                el último sync BUENO, que es justo lo que hace
                                invisible el fallo. */}
                            <strong>
                              {health.at
                                ? `La última sincronización falló el ${formatLastSync(health.at)}.`
                                : "La última sincronización falló."}
                            </strong>{" "}
                            {health.errorMessage}
                          </p>
                        ) : null}

                        {row.runs.length > 0 ? (
                          <details suppressHydrationWarning className="conexHistory">
                            <summary>Historial de sincronización</summary>
                            <table className="conexRunTable">
                              <thead>
                                <tr>
                                  <th>Cuándo</th>
                                  <th>Origen</th>
                                  <th>Resultado</th>
                                </tr>
                              </thead>
                              <tbody>
                                {row.runs.map((run) => {
                                  // Una corrida sin ningún sello de tiempo no pasó
                                  // «Nunca» —que es lo que diría `formatLastSync`—:
                                  // pasó sin dejar hora, y eso es una raya.
                                  const at = runInstantOf(run);
                                  return (
                                    <tr key={run.id}>
                                      <td>{at ? formatLastSync(at) : "—"}</td>
                                      <td>{describeTrigger(run.trigger)}</td>
                                      <td>{describeRunOutcome(run.status)}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </details>
                        ) : null}

                        {/* El pliegue lo escribe cada adapter (sus opciones
                            eliminar/congelar difieren), pero la palabra con la
                            que se abre es la misma en todas las filas. */}
                        <definition.DisconnectFold
                          currentUrl={currentUrl}
                          sourceId={source.id}
                          summary="Desconectar"
                        />
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {available.length === 0 ? null : (
        <div className="conexAvailable">
          <h3>Sin conectar</h3>
          {available.map(({ definition }) => (
            <div className="conexAvailableRow" key={definition.adapter}>
              <span className="conexName">{definition.label}</span>
              <span className="conexSub">{definition.mirrors}</span>
              {/* Un error de conexión vuelve por redirect etiquetado con el
                  `formId` del adapter: su pliegue se reabre solo, para que el
                  aviso de arriba no hable de un formulario que está plegado. */}
              <details
                suppressHydrationWarning
                className="conexConnect"
                open={errorFormId === definition.formId}
              >
                <summary>Conectar</summary>
                <form action={definition.connectAction} className="stackForm">
                  <input name="currentUrl" type="hidden" value={currentUrl} />
                  {definition.fields.map((field) => (
                    <label key={field.name}>
                      {field.label}
                      <input
                        aria-label={field.label}
                        autoComplete="off"
                        name={field.name}
                        placeholder={field.placeholder}
                        type="password"
                      />
                    </label>
                  ))}
                  <p className="muted">{definition.intro}</p>
                  <button type="submit">{definition.connectLabel}</button>
                </form>
              </details>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

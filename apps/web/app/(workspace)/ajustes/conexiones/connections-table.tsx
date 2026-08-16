import { formatLastSync } from "@web/ajustes/numista-helpers";
import { PendingSubmit } from "@web/pending-submit";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import { Fragment } from "react";
import type { ConnectionDefinition } from "./connection-registry";
import type { ConnectionRow } from "./connection-rows";

/**
 * El libro de conexiones (#1223, PRD #1222) — la disposición que salió del
 * prototipo (rama `prototipo/1223-conexiones`, variante A): una FILA por
 * conexión con lo que se sabe de un vistazo, y bajo esa misma fila el pliegue
 * con lo que se puede hacer. Nada obliga a navegar para actuar.
 *
 * El pliegue es también el hueco de los slices siguientes: el historial de
 * corridas (S2 #1224) y la edición de credenciales (S3 #1225) entran ahí sin
 * mover la fila.
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

                return (
                  <Fragment key={definition.adapter}>
                    <tr>
                      <td>
                        <span className="conexName">{definition.label}</span>
                        <span className="conexSub">{definition.mirrors}</span>
                      </td>
                      <td>
                        <span className="coinStatusPill">Conectado</span>
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

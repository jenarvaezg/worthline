import type { MyInvestorAcceptance } from "@web/ajustes/myinvestor-credentials";
import type { MyInvestorFirstStartView } from "@web/ajustes/myinvestor-selection";
import MyInvestorSyncPanel from "@web/ajustes/myinvestor-sync-panel";
import type {
  MyInvestorBandEntry,
  MyInvestorStanding,
} from "@web/ajustes/myinvestor-sync-view";
import { formatLastSync } from "@web/ajustes/numista-helpers";
import { PendingSubmit } from "@web/pending-submit";
import { type SyncRun, syncRunInstant } from "@worthline/db";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import { Fragment } from "react";
import type { ConnectionDefinition, CredentialField } from "./connection-registry";
import type { ConnectionRow } from "./connection-rows";
import {
  MyInvestorIncludedProducts,
  MyInvestorReadProducts,
  MyInvestorStateCell,
} from "./myinvestor-first-start";
import { myInvestorRowState } from "./myinvestor-first-start-view";
import MyInvestorIncludeFold from "./myinvestor-include-fold";
import { MyInvestorAvailable, MyInvestorConnectedDetail } from "./myinvestor-row";
import type { MyInvestorAvailability } from "./myinvestor-view";
import {
  describeRunOutcome,
  describeRunStep,
  describeSyncState,
  describeTrigger,
  type SyncHealthTone,
  summarizeSyncHealth,
} from "./sync-health";

/**
 * Con qué se dibuja cada tono. El tono es semántico y lo decide el módulo puro;
 * la clase es cosa de aquí. `ok` no añade ninguna: el verde es el punto base de
 * `.coinStatusPill`, y `muted` reusa la clase que ya significa «sin señal viva».
 */
const TONE_CLASS: Record<SyncHealthTone, string> = {
  error: "isError",
  muted: "isStale",
  ok: "",
  pending: "isPending",
};

/**
 * El libro de conexiones (#1223, PRD #1222) — la disposición que salió del
 * prototipo (rama `prototipo/1223-conexiones`, variante A): una FILA por
 * conexión con lo que se sabe de un vistazo, y bajo esa misma fila el pliegue
 * con lo que se puede hacer. Nada obliga a navegar para actuar.
 *
 * Bajo la fila cuelgan, en ese orden: el motivo de un sync fallido (visible sin
 * abrir nada), el pliegue de cambiar credenciales (S3 #1225 — el remedio, pegado
 * al motivo), el del historial de corridas (S2 #1224, diagnóstico) y el de
 * desconexión (destructivo, el último).
 *
 * Cero JSX por fuente: todo lo que distingue a un adapter de otro llega en su
 * entrada del registry.
 */

export interface ConnectionEntry {
  definition: ConnectionDefinition;
  row: ConnectionRow;
}

/** What the MyInvestor rows need beyond the registry (#1879). */
export interface MyInvestorTableContext {
  /** What the «Sin conectar» row offers: the fold, or one line saying why not. */
  availability: MyInvestorAvailability;
  /** The remembered password's acceptance, or null when only the device is kept. */
  savedPassword: MyInvestorAcceptance | null;
  /** The session's email, to say «tú» to whoever accepted it. */
  viewerEmail: string | null;
  /** What the last read of MyInvestor found (#1880), or null when nothing was read. */
  firstStart: MyInvestorFirstStartView | null;
  /** Today, `YYYY-MM-DD`, to tell whether the last read is today's. */
  today: string;
  /**
   * How «Poner al día» stands (#1884), whether this session may press it, and what
   * the row says under it: the lasting state and the health signals (#1885).
   */
  sync: {
    standing: MyInvestorStanding;
    readOnly: boolean;
    notices: readonly MyInvestorBandEntry[];
    /** The daily sync is stopped (the SMS, the rejected saved password): enter again. */
    stopped: boolean;
  };
}

/**
 * The lead of a notice and the rest, as `.conexSyncError` says it: the first
 * sentence in bold, the reason after it (#1224).
 */
function noticeParts(text: string): { lead: string; rest: string } {
  const end = text.indexOf(". ");
  return end === -1
    ? { lead: text, rest: "" }
    : { lead: text.slice(0, end + 1), rest: text.slice(end + 2) };
}

/**
 * The retained runs of a source, under its row (#1224): when, who and how it
 * ended — and, for a source that logs its attempts by step (MyInvestor, #1885),
 * where it failed.
 */
function SyncRunHistory({ runs }: { runs: readonly SyncRun[] }) {
  if (runs.length === 0) return null;
  return (
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
          {runs.map((run) => {
            // Una corrida sin ningún sello de tiempo no pasó «Nunca» —que es lo
            // que diría `formatLastSync`—: pasó sin dejar hora, y eso es una raya.
            const at = syncRunInstant(run);
            const step = run.status === "error" ? describeRunStep(run.error?.step) : null;
            return (
              <tr key={run.id}>
                <td>{at ? formatLastSync(at) : "—"}</td>
                <td>{describeTrigger(run.trigger)}</td>
                <td>
                  {describeRunOutcome(run.status)}
                  {step ? <span className="conexSub">{step}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

/**
 * Los campos de credenciales que declara un adapter, pintados igual en los DOS
 * sitios donde se piden: al conectar por primera vez y al cambiarlas sin
 * desconectar (#1225). Siempre `type="password"` y sin autocompletar — un secreto
 * no se pinta en claro ni se guarda en el gestor de contraseñas del navegador.
 */
function CredentialFields({ fields }: { fields: readonly CredentialField[] }) {
  return fields.map((field) => (
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
  ));
}

export default function ConnectionsTable({
  connections,
  currentUrl,
  errorFormId,
  myInvestor,
  privacyMode,
}: {
  connections: ConnectionEntry[];
  currentUrl: string;
  /** El `formId` del error que traiga la URL, o null si no trae ninguno. */
  errorFormId: string | null;
  myInvestor: MyInvestorTableContext;
  privacyMode: boolean;
}) {
  const connected = connections.filter((entry) => entry.row.source !== null);
  const available = connections.filter((entry) => entry.row.source === null);
  // MyInvestor's «Elegir qué incluir» (#1880, design D) is drawn AFTER the table,
  // out of `.tableScroll`: its panel is sticky, and a sticky box inside a scroll
  // container sticks to that container, not to the page.
  const myInvestorSource =
    connected.find((entry) => entry.definition.kind === "myinvestor")?.row ?? null;
  const choosing =
    myInvestorSource?.source && myInvestorSource.unitCount === 0 && myInvestor.firstStart
      ? { sourceId: myInvestorSource.source.id, view: myInvestor.firstStart }
      : null;

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
                // La salud NO sale de `last_sync_at`: esa columna dice cuándo fue
                // el último sync BUENO, y por sí sola no distingue «todo en orden»
                // de «lleva tres días fallando» (#1224).
                const health = summarizeSyncHealth({
                  freshness: row.freshness,
                  lastSyncAt: source.lastSyncAt,
                  runs: row.runs,
                });
                const state = describeSyncState(health.state);

                if (definition.kind === "myinvestor") {
                  return (
                    <Fragment key={definition.adapter}>
                      <tr>
                        <td>
                          <span className="conexName">{definition.label}</span>
                          <span className="conexSub">{definition.mirrors}</span>
                        </td>
                        <td>
                          {/* Until something is included (#1880) there is no
                              sync health to speak of: the next step is the state. */}
                          <MyInvestorStateCell
                            savedPassword={myInvestor.savedPassword !== null}
                            state={myInvestorRowState({
                              hasDiscovery: myInvestor.firstStart !== null,
                              lastSyncAt: source.lastSyncAt,
                              linkedCount: row.unitCount,
                              today: myInvestor.today,
                            })}
                          />
                        </td>
                        <td>{formatLastSync(source.lastSyncAt)}</td>
                        <td className="conexNum">
                          {row.unitCount}
                          <span className="conexSub">{definition.unitLabel}</span>
                        </td>
                        <td className="conexNum">
                          {row.unitCount === 0
                            ? "—"
                            : formatMoneyMinorPrivacy(
                                { amountMinor: row.valueMinor, currency: "EUR" },
                                privacyMode,
                              )}
                        </td>
                        <td>
                          {/* «Poner al día» where the other sources say «Sincronizar»
                              (#1884): the same pass as the ficha's, once something
                              is included. */}
                          {row.unitCount > 0 ? (
                            <MyInvestorSyncPanel
                              blockedLine={myInvestor.sync.standing.blocked?.line ?? null}
                              currentUrl={currentUrl}
                              dailyLine={myInvestor.sync.standing.dailyLine}
                              lastGood={formatLastSync(source.lastSyncAt)}
                              lastLine={null}
                              layout="row"
                              readOnly={myInvestor.sync.readOnly}
                              resync={false}
                              runningSince={
                                myInvestor.sync.standing.running?.since ?? null
                              }
                              savedPassword={myInvestor.savedPassword !== null}
                              sourceId={source.id}
                            />
                          ) : null}
                        </td>
                      </tr>
                      <tr className="conexDetailRow">
                        <td colSpan={6}>
                          {/* What lasts and the health signals (#1885), outside
                              every fold, with the grammar of a failed sync
                              (#1224). Their way out is this row: «Poner al día»
                              (which asks for a password when none is saved) and,
                              while the daily sync is stopped, «Volver a entrar»,
                              opened below (#1876). */}
                          {myInvestor.sync.notices.map((notice) => {
                            const { lead, rest } = noticeParts(notice.text);
                            return (
                              <p
                                className={`conexSyncError${notice.tone === "warn" ? " isWarn" : ""}`}
                                key={notice.text}
                              >
                                <strong>{lead}</strong>
                                {rest ? ` ${rest}` : null}
                              </p>
                            );
                          })}
                          {myInvestor.firstStart === null ? (
                            <details
                              suppressHydrationWarning
                              className="conexCredentials"
                              open
                            >
                              <summary>Elegir qué incluir</summary>
                              <MyInvestorReadProducts
                                currentUrl={currentUrl}
                                savedPassword={myInvestor.savedPassword !== null}
                                sourceId={source.id}
                              />
                            </details>
                          ) : row.unitCount > 0 ? (
                            <MyInvestorIncludedProducts
                              currentUrl={currentUrl}
                              privacyMode={privacyMode}
                              rows={myInvestor.firstStart.rows}
                              sourceId={source.id}
                            />
                          ) : null}
                          <SyncRunHistory runs={row.runs} />
                          <MyInvestorConnectedDetail
                            currentUrl={currentUrl}
                            disconnectFormId={definition.disconnectFormId}
                            errorFormId={errorFormId}
                            passwordFormId={definition.passwordFormId}
                            reenterOpen={myInvestor.sync.stopped}
                            savedPassword={myInvestor.savedPassword}
                            sourceId={source.id}
                            viewerEmail={myInvestor.viewerEmail}
                          />
                        </td>
                      </tr>
                    </Fragment>
                  );
                }

                return (
                  <Fragment key={definition.adapter}>
                    <tr>
                      <td>
                        <span className="conexName">{definition.label}</span>
                        <span className="conexSub">{definition.mirrors}</span>
                      </td>
                      <td>
                        <span
                          className={`coinStatusPill ${TONE_CLASS[state.tone]}`.trim()}
                        >
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

                        {/* Cambiar credenciales sin desconectar (#1225): una clave
                            rotada o revocada es la causa más común de un sync
                            fallido, así que el remedio va JUNTO al motivo — por
                            delante del historial (diagnóstico) y de la desconexión
                            (destructiva, y hasta ahora el único camino para esto).
                            Se reabre solo cuando el error lo produjo ESTE pliegue. */}
                        <details
                          suppressHydrationWarning
                          className="conexCredentials"
                          open={errorFormId === definition.credentialsFormId}
                        >
                          <summary>Cambiar credenciales</summary>
                          <form
                            action={definition.recredentialAction}
                            className="stackForm"
                          >
                            <input name="currentUrl" type="hidden" value={currentUrl} />
                            <input name="sourceId" type="hidden" value={source.id} />
                            <CredentialFields fields={definition.fields} />
                            <p className="muted">
                              Se comprueban contra {definition.label} antes de guardarse:
                              si las rechaza, las de ahora siguen intactas. La conexión no
                              se corta, así que no se pierden ni las posiciones ni el
                              histórico.
                            </p>
                            <PendingSubmit pendingLabel="Comprobando…">
                              {definition.recredentialLabel}
                            </PendingSubmit>
                          </form>
                        </details>

                        <SyncRunHistory runs={row.runs} />

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

      {choosing ? (
        <details
          suppressHydrationWarning
          className="conexCredentials myinvestorChoose"
          open
        >
          <summary>MyInvestor · Elegir qué incluir</summary>
          <MyInvestorIncludeFold
            currentUrl={currentUrl}
            others={choosing.view.others}
            own={choosing.view.own}
            privacyMode={privacyMode}
            sourceId={choosing.sourceId}
          />
        </details>
      ) : null}

      {available.length === 0 ? null : (
        <div className="conexAvailable">
          <h3>Sin conectar</h3>
          {available.map(({ definition }) =>
            definition.kind === "myinvestor" ? (
              <div className="conexAvailableRow" key={definition.adapter}>
                <span className="conexName">{definition.label}</span>
                <span className="conexSub">{definition.mirrors}</span>
                <MyInvestorAvailable
                  availability={myInvestor.availability}
                  currentUrl={currentUrl}
                />
              </div>
            ) : (
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
                    <CredentialFields fields={definition.fields} />
                    <p className="muted">{definition.intro}</p>
                    <button type="submit">{definition.connectLabel}</button>
                  </form>
                </details>
              </div>
            ),
          )}
        </div>
      )}
    </>
  );
}

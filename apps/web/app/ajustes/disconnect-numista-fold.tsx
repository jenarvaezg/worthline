/**
 * The Numista disconnect CHOICE (PRD #160 story 21, ADR 0016), shared by the
 * settings tile and the coin-collection detail surface so the two options read
 * identically wherever the user disconnects.
 *
 * A single zero-JS form (ADR 0009) with two submit buttons that post a `mode`:
 *  - "remove" — eliminate the live holding; frozen snapshots keep the history.
 *  - "freeze" — convert it into a plain hand-maintained precious-metal holding,
 *    keeping its current value.
 */

import { disconnectNumistaAction } from "./numista-actions";

export default function DisconnectNumistaFold({
  currentUrl,
  sourceId,
  summary = "Desconectar",
}: {
  currentUrl: string;
  sourceId: string;
  summary?: string;
}) {
  return (
    <form action={disconnectNumistaAction}>
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="sourceId" type="hidden" value={sourceId} />
      <details className="confirmDelete">
        <summary>{summary}</summary>
        <p className="dangerExplain">
          La clave de API se borra de este dispositivo; tu colección en Numista no se
          toca. Elige qué hacer con el activo en worthline:
        </p>
        <div className="disconnectChoice">
          <div className="disconnectOption">
            <button name="mode" type="submit" value="remove">
              Eliminar y conservar histórico
            </button>
            <span className="muted">
              Borra la colección y todas sus monedas. Los snapshots ya guardados conservan
              el histórico.
            </span>
          </div>
          <div className="disconnectOption">
            <button className="disconnectFreeze" name="mode" type="submit" value="freeze">
              Convertir en activo manual
            </button>
            <span className="muted">
              Congela el valor actual en un activo de metal precioso que mantienes a mano.
            </span>
          </div>
        </div>
      </details>
    </form>
  );
}

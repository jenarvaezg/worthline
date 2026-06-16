/**
 * The Binance disconnect CHOICE (PRD #245 S6, ADR 0016/0021), shared by the
 * settings tile and the Binance holding detail surface so the two options read
 * identically wherever the user disconnects.
 *
 * A single zero-JS form (ADR 0009) with two submit buttons that post a `mode`:
 *  - "remove" — eliminate the live holdings (all rungs); frozen snapshots keep
 *    the history.
 *  - "freeze" — convert each rung into a plain hand-maintained holding, keeping
 *    its current value.
 */

import { disconnectBinanceAction } from "./binance-actions";

export default function DisconnectBinanceFold({
  currentUrl,
  sourceId,
  summary = "Desconectar Binance",
}: {
  currentUrl: string;
  sourceId: string;
  summary?: string;
}) {
  return (
    <form action={disconnectBinanceAction}>
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="sourceId" type="hidden" value={sourceId} />
      <details className="confirmDelete">
        <summary>{summary}</summary>
        <p className="dangerExplain">
          La clave de API se borra de este dispositivo; tu cuenta en Binance no se toca.
          Elige qué hacer con el activo en worthline:
        </p>
        <div className="disconnectChoice">
          <div className="disconnectOption">
            <button name="mode" type="submit" value="remove">
              Eliminar y conservar histórico
            </button>
            <span className="muted">
              Borra las posiciones de Binance (mercado y bloqueadas). Los snapshots ya
              guardados conservan el histórico.
            </span>
          </div>
          <div className="disconnectOption">
            <button className="disconnectFreeze" name="mode" type="submit" value="freeze">
              Convertir en activo manual
            </button>
            <span className="muted">
              Congela el valor actual en activos que mantienes a mano (uno por cada
              peldaño).
            </span>
          </div>
        </div>
      </details>
    </form>
  );
}

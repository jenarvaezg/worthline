/**
 * The Binance disconnect CHOICE (PRD #245 S6, ADR 0016/0021), shared by the
 * Conexiones row and a rung's ficha (#1849) so the two options read identically
 * wherever the user disconnects. The shape is `disconnect-choice`; the words are
 * Binance's:
 *  - "remove" — eliminate the live holdings (all rungs); frozen snapshots keep
 *    the history.
 *  - "freeze" — convert each rung into a plain hand-maintained holding, keeping
 *    its current value.
 */

import type { FormErrorContext } from "@web/intake";
import { disconnectBinanceAction } from "./binance-actions";
import { BINANCE_DISCONNECT_FORM_ID } from "./connected-source-form-ids";
import {
  type DisconnectCopy,
  DisconnectFold,
  DisconnectPanelForm,
} from "./disconnect-choice";

const BINANCE_DISCONNECT_COPY: DisconnectCopy = {
  freeze:
    "Congela el valor actual en activos que mantienes a mano (uno por cada peldaño).",
  intro:
    "La clave de API se borra de este dispositivo; tu cuenta en Binance no se toca. Elige qué hacer con el activo en worthline:",
  remove:
    "Borra las posiciones de Binance (mercado y bloqueadas). Los snapshots ya guardados conservan el histórico.",
};

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
    <DisconnectFold
      action={disconnectBinanceAction}
      copy={BINANCE_DISCONNECT_COPY}
      currentUrl={currentUrl}
      sourceId={sourceId}
      summary={summary}
    />
  );
}

/** «Desconectar Binance» in a rung ficha's side panel (#1849). */
export function DisconnectBinanceForm(props: {
  currentUrl: string;
  formError: FormErrorContext | null;
  readOnly: boolean;
  sourceId: string;
}) {
  return (
    <DisconnectPanelForm
      action={disconnectBinanceAction}
      copy={BINANCE_DISCONNECT_COPY}
      formId={BINANCE_DISCONNECT_FORM_ID}
      {...props}
    />
  );
}

/**
 * The Numista disconnect CHOICE (PRD #160 story 21, ADR 0016), shared by the
 * Conexiones row and the collection's ficha (#1849) so the two options read
 * identically wherever the user disconnects. The shape is `disconnect-choice`;
 * the words are Numista's:
 *  - "remove" — eliminate the live holding; frozen snapshots keep the history.
 *  - "freeze" — convert it into a plain hand-maintained precious-metal holding,
 *    keeping its current value.
 */

import type { FormErrorContext } from "@web/intake";
import { NUMISTA_DISCONNECT_FORM_ID } from "./connected-source-form-ids";
import {
  type DisconnectCopy,
  DisconnectFold,
  DisconnectPanelForm,
} from "./disconnect-choice";
import { disconnectNumistaAction } from "./numista-actions";

const NUMISTA_DISCONNECT_COPY: DisconnectCopy = {
  freeze: "Congela el valor actual en un activo de metal precioso que mantienes a mano.",
  intro:
    "La clave de API se borra de este dispositivo; tu colección en Numista no se toca. Elige qué hacer con el activo en worthline:",
  remove:
    "Borra la colección y todas sus monedas. Los snapshots ya guardados conservan el histórico.",
};

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
    <DisconnectFold
      action={disconnectNumistaAction}
      copy={NUMISTA_DISCONNECT_COPY}
      currentUrl={currentUrl}
      sourceId={sourceId}
      summary={summary}
    />
  );
}

/** «Desconectar Numista» in the collection ficha's side panel (#1849). */
export function DisconnectNumistaForm(props: {
  currentUrl: string;
  formError: FormErrorContext | null;
  readOnly: boolean;
  sourceId: string;
}) {
  return (
    <DisconnectPanelForm
      action={disconnectNumistaAction}
      copy={NUMISTA_DISCONNECT_COPY}
      formId={NUMISTA_DISCONNECT_FORM_ID}
      {...props}
    />
  );
}

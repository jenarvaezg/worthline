import { EXTRACTED_DOCUMENT_SCHEMA } from "@web/asistente/chat-tools/schemas/reads";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { TOOL_PROMPT_BUDGET } from "@web/asistente/turn-prompt-budget";
import {
  extractedDocumentDetail,
  typedDocumentCard,
} from "@web/asistente/typed-attachment-prompt";
import { type ToolSet, tool } from "ai";

/**
 * Reading one of THIS turn's validated attachments in full (#1492). The DATOS
 * ESTRUCTURADOS block may only carry the summary; this is how a concrete row gets
 * cited without the model inventing it. A file that is not in the turn's context is
 * refused, never guessed at.
 */
export function documentReadTools(turn: ChatToolTurn): ToolSet {
  const { input } = turn;

  return {
    get_extracted_document: tool({
      description:
        "Lee el detalle entero de un adjunto validado en este turno, por su fileName. " +
        "Úsala cuando los DATOS ESTRUCTURADOS traigan solo el RESUMEN, o para citar una " +
        "fila concreta de un extracto. Si el fichero no está entre los 3 en contexto, " +
        "la app rechaza.",
      inputSchema: EXTRACTED_DOCUMENT_SCHEMA,
      execute: (args) => {
        const fileName = args.fileName.trim();
        const match = (input.validatedAttachments ?? []).find(
          (attachment) => attachment.fileName === fileName,
        );
        if (!match) {
          return {
            error: "not_in_context",
            message:
              "Ese fichero no está en el contexto de este turno. Solo puedes pedir " +
              "uno de los adjuntos validados que ves en DATOS ESTRUCTURADOS.",
          };
        }
        const card = typedDocumentCard(match.fileName, match.document, false);
        const detail = extractedDocumentDetail(match.document);
        if (
          detail !== null &&
          JSON.stringify(detail).length > TOOL_PROMPT_BUDGET.totalChars
        ) {
          return {
            card,
            error: "too_large",
            message:
              "El detalle de este documento no cabe en una respuesta de tool. " +
              "Usa la ficha; no pidas el detalle entero.",
          };
        }
        return { card, detail };
      },
    }),
  };
}

export const MAX_ATTACHMENT_FILE_NAME_CHARS = 255;

/**
 * Card message when a readable spreadsheet is handed to the model to discuss.
 * It lives in this client-safe leaf because it is also the marker the
 * unvalidated-evidence boundary reads back out of history (#1248): keeping it
 * here lets the chat-context module recognize it without dragging the
 * spreadsheet parser into the assistant's client bundle.
 */
export const UNSTRUCTURED_SPREADSHEET_MESSAGE =
  "No es una tabla de posiciones para importar, así que no hay ninguna lectura validada: lo que te cuente de este archivo sale de mirar su contenido, no de datos comprobados.";

/**
 * Card message when the vision seam identifies no document it knows how to read
 * (#1243). It sits next to {@link UNSTRUCTURED_SPREADSHEET_MESSAGE} for the same
 * reason: it is a marker another module reads back off the envelope. Both shapes of
 * "nothing extracted" stay `unrecognized` — the contract grows no fourth outcome —
 * but only THIS one means "I did not identify a document", which is the drain
 * #1246's descriptive reading hangs off. "Identified the document, read no rows"
 * carries its own message instead, so the two can never be confused.
 */
export const UNIDENTIFIED_DOCUMENT_MESSAGE =
  "No reconozco en este archivo ninguno de los documentos que sé leer.";

/**
 * Card message when the vision seam identified no document and the descriptive
 * reading DID produce a description of what is on screen (#1246) — the image-side
 * twin of {@link UNSTRUCTURED_SPREADSHEET_MESSAGE}, and a distinct constant for the
 * same reason: it is the marker the unvalidated-evidence boundary reads back out of
 * history (#1248). Without its own marker the descriptive path would open the
 * two-turn bypass again, this time for captures.
 *
 * It is deliberately NOT {@link UNIDENTIFIED_DOCUMENT_MESSAGE}: that one is the
 * dead-end (nothing identified and nothing described), and the model got no document
 * at all, so it must not count as evidence.
 *
 * Neither this message nor its spreadsheet twin may promise a reading «aquí debajo»
 * (#1287): the description is fed to the MODEL and the card renders none of it, so
 * what follows on screen is the assistant's answer, not the reading. Both say what is
 * true instead — there is no validated reading, and whatever comes next stands on
 * looking rather than on checked data. Pinning the provenance in the card itself is a
 * different job, and it needs the envelope to carry the text (#1261 first).
 */
export const UNSTRUCTURED_VISION_MESSAGE =
  "No reconozco aquí ningún documento que sepa extraer, así que no hay ninguna lectura validada: lo que te cuente de esta imagen sale de mirarla, no de datos comprobados.";

/**
 * Card message when the vision seam DID identify the document, could not read a single
 * row, and the descriptive reading then said what is on screen — #1246's drain, widened
 * to both shapes of `unrecognized`.
 *
 * It is a THIRD marker and not a reuse of {@link UNSTRUCTURED_VISION_MESSAGE} because the
 * two facts are different and the user reads the difference: that one says «no reconozco
 * ningún documento», which would be a lie on a capture whose document we did recognize.
 * Like its two siblings it is a marker the unvalidated-evidence boundary reads back out of
 * history (#1248), so it MUST stay in `UNSTRUCTURED_EVIDENCE_MESSAGES` — a described
 * capture is evidence worthline never validated, whichever verdict sent it down the lane.
 */
export const UNSTRUCTURED_EMPTY_READING_MESSAGE =
  "Reconozco el documento, pero no he podido leer ninguna de sus filas, así que no hay ninguna lectura validada: lo que te cuente de este archivo sale de mirarlo, no de datos comprobados.";

/**
 * Card message for the dead end of that same case: the document was identified, no row
 * could be read, and no model turn follows either (#1246). The twin of
 * {@link UNIDENTIFIED_DOCUMENT_MESSAGE} for the other shape of `unrecognized`, and like
 * it — and unlike the message above — it must NEVER join `UNSTRUCTURED_EVIDENCE_MESSAGES`:
 * nothing was handed to the model, so nothing may close the gate on its account.
 */
export const EMPTY_READING_MESSAGE =
  "Reconozco el documento, pero no he podido leer ninguna de sus filas.";

/**
 * Card message when this client cannot fully validate the payload of a reading and
 * the payload carries no message of its own to paint — a document written by a newer
 * worthline, so its table cannot be rendered here (#1261). It names the real cause
 * instead of apologizing, because the fix is a reload and only the user can do it.
 *
 * It lives among the other card messages for discoverability, but unlike them it is
 * NOT a marker anyone reads back off history, and it must never join
 * `UNSTRUCTURED_EVIDENCE_MESSAGES`: this card means the model got no document at all.
 */
export const PREVIEW_VERSION_SKEW_MESSAGE =
  "Esta lectura la ha generado una versión más reciente de worthline. Recarga la página para verla completa.";

/** Client-safe v1 type catalog shared by picker, transport and server validation. */
export const ATTACHMENT_TYPES_V1 = [
  {
    extensions: [".png"],
    fallbackMimeType: "image/png",
    kind: "image",
    mimeTypes: ["image/png"],
  },
  {
    extensions: [".jpeg", ".jpg"],
    fallbackMimeType: "image/jpeg",
    kind: "image",
    mimeTypes: ["image/jpeg"],
  },
  {
    extensions: [".webp"],
    fallbackMimeType: "image/webp",
    kind: "image",
    mimeTypes: ["image/webp"],
  },
  {
    extensions: [".heic"],
    fallbackMimeType: "image/heic",
    kind: "image",
    mimeTypes: ["image/heic"],
  },
  {
    extensions: [".heif"],
    fallbackMimeType: "image/heif",
    kind: "image",
    mimeTypes: ["image/heif"],
  },
  {
    extensions: [".csv"],
    fallbackMimeType: "text/csv",
    kind: "spreadsheet",
    mimeTypes: ["application/csv", "application/vnd.ms-excel", "text/csv"],
  },
  {
    extensions: [".xlsx"],
    fallbackMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "spreadsheet",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  },
  {
    extensions: [".pdf"],
    fallbackMimeType: "application/pdf",
    kind: "pdf",
    mimeTypes: ["application/pdf"],
  },
] as const;

export const ASSISTANT_ATTACHMENT_ACCEPT = ATTACHMENT_TYPES_V1.flatMap((type) => [
  ...type.extensions,
  ...type.mimeTypes,
]).join(",");

export function attachmentMimeTypeForFileName(fileName: string): string {
  const normalized = fileName.trim().toLowerCase();
  return (
    ATTACHMENT_TYPES_V1.find((type) =>
      type.extensions.some((extension) => normalized.endsWith(extension)),
    )?.fallbackMimeType ?? ""
  );
}

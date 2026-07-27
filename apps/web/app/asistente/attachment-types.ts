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

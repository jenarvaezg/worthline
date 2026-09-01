/**
 * Every shape the chat route can answer with (#1697, extracted from `route.ts`).
 *
 * One module because the choice between them is a product decision the route makes
 * over and over: a bare 4xx reads in the panel as a generic Error, so a door the USER
 * can do something about streams a 200 instead — the honest paywall (#1162), or the
 * extraction card that was already paid for (#1130, #1242).
 */

import type { AttachmentPreviewData } from "@web/asistente/attachment-chat";
import type { UnstructuredReading } from "@web/asistente/attachment-turn";
import {
  EMPTY_READING_MESSAGE,
  UNIDENTIFIED_DOCUMENT_MESSAGE,
} from "@web/asistente/attachment-types";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessageChunk,
} from "ai";
import { NextResponse } from "next/server";

export const NO_STORE = { "Cache-Control": "no-store" };

export function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * Stream the honest paywall (#1162) instead of an error: a `data-paywall` part
 * the assistant panel renders as a premium reminder. A 200 stream, not a 4xx,
 * so it reads as a normal assistant turn — never a scary failure, never a wall
 * in front of the user's own data.
 */
export function paywallResponse(message: string): Response {
  return createUIMessageStreamResponse({
    headers: NO_STORE,
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "data-paywall", data: { message } });
      },
    }),
  });
}

/**
 * The ONE place that writes the extraction preview card into a stream. Every exit
 * that has already paid for an extraction must show its verdict — with the model
 * turn merged in when there is one, alone when the model is unreachable (#1242).
 */
export function attachmentCardStream(
  preview: AttachmentPreviewData,
  providerStream: ReadableStream<UIMessageChunk> | null,
): ReadableStream<UIMessageChunk> {
  return createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "data-attachment-extraction", data: preview });
      if (providerStream) writer.merge(providerStream);
    },
  });
}

/**
 * The card to show when there will be NO model turn under it.
 *
 * The unstructured lanes replace the verdict with a card that promises the
 * conversation continues — «te comento lo que veo del archivo aquí debajo» (#865),
 * «te cuento lo que veo aquí debajo» (#1246). That promise is only true when the
 * model answers. On a model-unreachable exit the user would read it with nothing
 * underneath, and on the #1246 lane they would have paid for TWO vision calls to
 * get it. So the honest dead-end message takes its place: nothing was extracted,
 * and this time nothing describes it either.
 */
export function previewWithoutModelTurn(
  preview: AttachmentPreviewData,
  unstructured: UnstructuredReading | null,
): AttachmentPreviewData {
  if (!unstructured) return preview;
  // Which dead end, though: an `empty_reading` capture is described too now (#1246), and
  // telling that user «no reconozco ninguno de los documentos que sé leer» would deny a
  // document the seam DID identify. The verdict is preserved and only the promise of a
  // conversation is withdrawn.
  const emptyReading =
    preview.result.status === "unrecognized" && preview.result.reason === "empty_reading";
  return {
    fileName: preview.fileName,
    result: emptyReading
      ? {
          message: EMPTY_READING_MESSAGE,
          reason: "empty_reading",
          status: "unrecognized",
        }
      : {
          message: UNIDENTIFIED_DOCUMENT_MESSAGE,
          reason: "unidentified_document",
          status: "unrecognized",
        },
  };
}

/**
 * The model is unreachable, but the extraction verdict was already paid for and
 * the user must read it (#1130): a 200 stream carrying just the card, never a
 * bare 4xx/5xx that the transport turns into a generic Error.
 */
export function previewOnlyResponse(
  preview: AttachmentPreviewData,
  unstructured: UnstructuredReading | null,
): Response {
  return createUIMessageStreamResponse({
    headers: NO_STORE,
    stream: attachmentCardStream(previewWithoutModelTurn(preview, unstructured), null),
  });
}

export function operationalCause(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}

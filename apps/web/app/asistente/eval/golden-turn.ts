/**
 * Turning a golden question into the turn a provider actually receives (#1254): its
 * attachment read, the frontier that reading opens, and the messages composed.
 *
 * Its own module for two reasons. It is the only part of the harness that touches the
 * filesystem, so the question sets stay pure and importable anywhere. And `run.ts`
 * calls `main()` at import time, which makes anything living there untestable — the
 * composition is exactly what must not be taken on trust, since a harness that sends
 * something other than what it claims scores a model on a turn nobody wrote.
 *
 * Everything here leans on the production seams the chat route runs —
 * {@link readAttachmentTurn}, `prepareAttachmentMessagesForModel`,
 * `unvalidatedEvidenceGateApplies` — so what the model sees in an eval is what a real
 * upload puts in front of it: same extraction verdict, same fences, same frontier. A
 * reimplementation would measure the reimplementation, which is the mistake #1265 had
 * to undo when the harness wired three of six tool stores.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AttachmentPreviewData,
  isValidatedDocument,
  parseAttachmentPreviewData,
  prepareAttachmentMessagesForModel,
  type ValidatedAttachment,
  validatedAttachmentsForTools,
  validatedDocumentsForTools,
} from "@web/asistente/attachment-chat";
import type { ExtractedDocument } from "@web/asistente/attachment-extraction-contract";
import {
  type AttachmentTurnReading,
  readAttachmentTurn,
} from "@web/asistente/attachment-turn";
import { attachmentMimeTypeForFileName } from "@web/asistente/attachment-types";
import { turnPromptBudget } from "@web/asistente/turn-prompt-budget";
import {
  NO_TYPED_BALANCE_SERIES,
  parseTypedBalanceSeries,
  type TypedBalanceSeriesReading,
} from "@web/asistente/typed-balance-series";
import { unvalidatedEvidenceGateApplies } from "@web/asistente/unvalidated-evidence-gate";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";

import type {
  GoldenAttachment,
  GoldenQuestion,
  GoldenValidatedDocument,
} from "./golden-question";

const ATTACHMENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "attachments");
const DOCUMENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "documents");

function resolveGoldenAttachmentPath(attachment: GoldenAttachment): string {
  return join(ATTACHMENTS_DIR, attachment.file);
}

/** The provider/model pair under test, and the one whose budget the turn is fitted to. */
export interface EvalCandidate {
  provider: string;
  model: string;
}

/**
 * Which lane the document actually arrived through.
 *
 * It reports one lane a question cannot DECLARE: `dead-end`, the honest verdict of a
 * file worthline could neither validate nor describe (unreadable, too large, a capture
 * nobody could read). No question grades that today — the model holds no document at
 * all there, so the turn is the ordinary manual path — and `GoldenAttachment.lane`
 * deliberately does not offer it rather than inviting a fixture nothing measures. The
 * asymmetry is on purpose: this function has to be able to NAME what it found, because
 * the value of the assertion is the mismatch message, and «no era unstructured» says
 * much less than «llegó como dead-end».
 */
export function laneOf(
  reading: AttachmentTurnReading,
): "unstructured" | "validated" | "dead-end" {
  if (reading.unstructured) return "unstructured";
  return isValidatedDocument(reading.preview) ? "validated" : "dead-end";
}

/**
 * Read one declared attachment and check it is the document the question thinks it is.
 *
 * The lane assertion is the point. Three of the attachment questions grade what the
 * model does NOT do — no bulk import, no proposal over an ambiguous holding — and
 * those checks only mean something while the turn really carries evidence worthline
 * could not validate. A fixture that started validating (a widened header alias) or a
 * file that went missing would hand the model a green it never earned, silently. So a
 * mismatch throws: the runner records the question as errored with every check failed,
 * which is loud in the report and in the exit code.
 */
export async function readGoldenAttachmentTurn(
  attachment: GoldenAttachment,
  today: string,
): Promise<AttachmentTurnReading> {
  const path = resolveGoldenAttachmentPath(attachment);
  const bytes = await readFile(path);
  const reading = await readAttachmentTurn({
    bytes: new Uint8Array(bytes),
    fileName: attachment.file,
    mimeType: attachmentMimeTypeForFileName(attachment.file),
    // The harness's own pinned clock (#1424), through the runner: a fixture dated
    // after it is the document's forecast, and grading it as an observation would
    // measure a reading no user gets.
    today,
  });
  const lane = laneOf(reading);
  if (lane !== attachment.lane) {
    throw new Error(
      `Attachment ${attachment.file} arrived as "${lane}", not the declared "${attachment.lane}".`,
    );
  }
  return reading;
}

/**
 * What the user said in the turn that uploaded the document, and what the assistant
 * answered then (#1376). Deliberately the emptiest pair that still makes a
 * conversation: neither names a holding, a figure or a direction, so everything the
 * question grades is decided in the turn under test and not handed over in history.
 *
 * «El archivo» and not «el justificante» since #1516: two document kinds travel this
 * lane now, and naming the receipt would tell a model carrying a broker's ledger what
 * kind of paper it is holding — a nudge towards the single-operation lane, handed over
 * in the history rather than read off the document.
 */
const DOCUMENT_UPLOAD_TURN = "Te subo el archivo.";
const DOCUMENT_UPLOAD_REPLY = "Lo he leído.";

/**
 * Read one declared validated document and check it is what the question thinks it is.
 *
 * The fixture is the extraction envelope the browser persists, and it is revalidated
 * through {@link parseAttachmentPreviewData} — the same function the chat route runs
 * on history — so what reaches the model is what a real conversation would carry, not
 * a literal this harness typed. Both assertions throw rather than degrade, for the
 * reason {@link readGoldenAttachmentTurn} states: a question that grades WHICH lane a
 * turn took is meaningless once the document silently stopped being that document, and
 * a silent green is worse than a loud error.
 */
export async function readGoldenValidatedDocument(
  document: GoldenValidatedDocument,
): Promise<AttachmentPreviewData> {
  const raw = await readFile(join(DOCUMENTS_DIR, document.file), "utf8");
  const preview = parseAttachmentPreviewData(JSON.parse(raw));
  if (preview === null || preview.result.status !== "valid") {
    throw new Error(
      `Document ${document.file} did not revalidate as a worthline extraction.`,
    );
  }
  const documentType = preview.result.data.documentType;
  if (documentType !== document.documentType) {
    throw new Error(
      `Document ${document.file} parsed as "${documentType}", not the declared "${document.documentType}".`,
    );
  }
  return preview;
}

/**
 * The exchange that put the document in context, in the shape the route receives it
 * from the browser: the user's upload turn, and the assistant reply that carries the
 * extraction card. The card rides on the ASSISTANT message because that is where the
 * stream emits it — and `prepareAttachmentMessagesForModel` strips it right back out,
 * which is the point: the model gets the structured block, never the card.
 */
export function documentHistoryMessages(
  document: AttachmentPreviewData | null,
): UIMessage[] {
  if (document === null) return [];
  return [
    {
      id: "documento-subido",
      role: "user",
      parts: [{ type: "text", text: DOCUMENT_UPLOAD_TURN }],
    },
    {
      id: "documento-leido",
      role: "assistant",
      parts: [
        { type: "data-attachment-extraction", data: document },
        { type: "text", text: DOCUMENT_UPLOAD_REPLY },
      ],
    },
  ];
}

/**
 * The unvalidated-evidence frontier for this turn (#1248), derived exactly as the
 * chat route derives it: from what THIS turn's own extraction produced.
 *
 * The history half of the route's rule (`hasUnstructuredEvidenceInHistory`) has
 * nothing to find here even since #1376 gave questions a history, and that is a
 * property of the fixtures rather than a shortcut: what an earlier turn may leave in
 * context is a VALIDATED document, and the trace that gate looks for is the card of an
 * unstructured one. A fixture that ever validated in the other direction would need
 * this function to read the history too.
 */
export function unvalidatedEvidenceFor(reading: AttachmentTurnReading | null): boolean {
  return unvalidatedEvidenceGateApplies({
    hasUnvalidatedEvidence: reading?.unstructured != null,
    hasValidatedDocumentInThisTurn: isValidatedDocument(reading?.preview),
  });
}

/**
 * The validated documents this turn's tools may take their rows from (#1373),
 * through the route's own function. Without it `propose_reconcile` refuses every
 * golden question by construction, and the harness would grade its own hole instead
 * of the model — the mistake #1265 had to undo, in the same shape.
 *
 * Both halves of the route's rule apply since #1376: this turn's own reading, and the
 * documents an earlier turn left in context. `propose_operation` lives entirely on the
 * second — a `holding_event` is uploaded in one message and acted on in the next — so
 * a harness that only forwarded the current turn could not grade that lane at all.
 */
export function validatedDocumentsFor(
  reading: AttachmentTurnReading | null,
  history: UIMessage[] = [],
): ExtractedDocument[] {
  return validatedDocumentsForTools(history, reading?.preview ?? null);
}

export function validatedAttachmentsFor(
  reading: AttachmentTurnReading | null,
  history: UIMessage[] = [],
): ValidatedAttachment[] {
  return validatedAttachmentsForTools(history, reading?.preview ?? null);
}

/**
 * The turn as the model receives it: the question, plus whatever the attachment seam
 * made of its document. Composed by `prepareAttachmentMessagesForModel` — the route's
 * own function — so the fences, the caps and the framing are the production ones.
 *
 * A question with no attachment goes through the same path and comes out as the single
 * user message the runner's old `prompt:` built, so there is one code path rather than
 * two, and no question kind is quietly composed differently from the other. A question
 * whose document is in HISTORY (#1376) is the same story one turn later: the exchange
 * that uploaded it goes in front, and the route's own function decides what survives.
 */
export async function buildTurnMessages(
  question: GoldenQuestion,
  reading: AttachmentTurnReading | null,
  candidate: EvalCandidate,
  history: UIMessage[] = [],
): Promise<ModelMessage[]> {
  const messages: UIMessage[] = [
    ...history,
    { id: question.id, role: "user", parts: [{ type: "text", text: question.question }] },
  ];
  return await convertToModelMessages(
    prepareAttachmentMessagesForModel(
      messages,
      reading?.preview ?? null,
      // The reading, not the already-fitted block: remaining budget after the
      // typed cards is computed inside, so a historical series and this turn's
      // notebook share one ceiling (#1492, #1419).
      reading?.unstructured ?? null,
      turnPromptBudget({ modelId: candidate.model, provider: candidate.provider })
        .attachmentChars,
    ),
  );
}

/**
 * The series the question's own text carries (#1418), through the route's parser and
 * gated the way the route gates it.
 *
 * Here for the reason {@link prepareGoldenTurn} states below: deriving the frontier and
 * NOT what reopens it is the #1373 mistake in a new place — a question that types a
 * dated series would be refused by the harness and scored as the model refusing.
 * `question.question` is the turn's only user message, which is what the route's
 * `typedBalanceSeriesInTurn` would pick out of a real history.
 */
export function typedBalanceSeriesFor(
  question: GoldenQuestion,
  unvalidatedEvidence: boolean,
): TypedBalanceSeriesReading {
  return unvalidatedEvidence
    ? parseTypedBalanceSeries(question.question)
    : NO_TYPED_BALANCE_SERIES;
}

/** Everything a golden question needs from the filesystem, ready for `generateText`. */
export interface GoldenTurn {
  messages: ModelMessage[];
  /** The #1248 gate, as the route derives it. */
  unvalidatedEvidence: boolean;
  /** What the question's own text holds, and so which debt lane reopens (#1418). */
  typedBalanceSeries: TypedBalanceSeriesReading;
  /** The rows a document lane may write from (#1373, #1376). */
  validatedDocuments: ExtractedDocument[];
  /** Same documents with file names, for `get_extracted_document` (#1492). */
  validatedAttachments: ValidatedAttachment[];
}

/**
 * Read a question's documents and compose its turn — all three halves at once.
 *
 * One function rather than a sequence the caller assembles, because the sequence is
 * where this harness has already been wrong twice: forwarding three of six tool stores
 * (#1265) and, in the same shape, the gate without the documents (#1373). Both bugs
 * graded the harness's own hole and read as a model defect. A caller that cannot get
 * two of the three from the same call cannot forget one of them either, and there is
 * exactly one place left where «what the model receives» is decided.
 */
export async function prepareGoldenTurn(
  question: GoldenQuestion,
  candidate: EvalCandidate,
  today: string,
): Promise<GoldenTurn> {
  // Both readings assert what the question DECLARES before anything is composed: a
  // mismatch throws here, and the runner records the question as errored with every
  // check failed rather than grading a turn nobody wrote.
  const reading = question.attachment
    ? await readGoldenAttachmentTurn(question.attachment, today)
    : null;
  const history = documentHistoryMessages(
    question.validatedDocument
      ? await readGoldenValidatedDocument(question.validatedDocument)
      : null,
  );
  const unvalidatedEvidence = unvalidatedEvidenceFor(reading);
  return {
    messages: await buildTurnMessages(question, reading, candidate, history),
    typedBalanceSeries: typedBalanceSeriesFor(question, unvalidatedEvidence),
    unvalidatedEvidence,
    validatedDocuments: validatedDocumentsFor(reading, history),
    validatedAttachments: validatedAttachmentsFor(reading, history),
  };
}

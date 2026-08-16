/**
 * The shape of a golden question and the checks every set shares.
 *
 * Split out when the harness grew a second dimension (#1265) so that neither
 * question set has to import the other's file to reuse `spanish` or `grounded`.
 * Why there are two dimensions at all: ADR 0067.
 */

import type { ExtractedDocument } from "@web/asistente/attachment-extraction-contract";
import type { PersonaId } from "@web/demo/persona";

import type { EvalDimension } from "./dimension";
import { type AssistantAnswer, citesEuros, isSpanish, usedReadTool } from "./graders";

export interface Check {
  name: string;
  pass: boolean;
}

/**
 * A committed file a question carries into the turn (#1254). The runner reads it
 * through the production seam, so the model sees exactly what a real upload puts in
 * front of it — the extraction verdict, the lane, and the frontier that lane opens.
 *
 * `lane` is not documentation: the runner ASSERTS it before grading. A question that
 * grades «did not attempt a bulk import» is only meaningful if the turn's document
 * actually opened the unvalidated-evidence gate, and a fixture that quietly started
 * validating (a header alias widened, say) would score a green the model never
 * earned. Declaring the lane turns that into a loud error instead — the same lesson
 * this issue took from a golden set that promised nine captures it did not have.
 */
export interface GoldenAttachment {
  /** File name under `eval/attachments/`, committed and free of real data. */
  file: string;
  /** `unstructured`: worthline could not validate it. `validated`: it could. */
  lane: "unstructured" | "validated";
}

/**
 * A document worthline ALREADY validated, sitting in the conversation's history
 * (#1376) — the second way a document reaches a turn, and the ordinary one: a user
 * uploads a confirmation, reads what worthline made of it, and asks for something in
 * the NEXT message. `validatedDocumentsInContext` is what carries it there, and it is
 * the only route by which a `holding_event` can reach an eval at all: that document
 * does not come out of a spreadsheet, so no CSV fixture can produce one and a PDF
 * fixture would spend a vision credential the harness's cost model does not have.
 *
 * The fixture is the extraction ENVELOPE as the browser persists it, so the runner
 * revalidates it through `parseAttachmentPreviewData` — the production seam — rather
 * than trusting a literal. `documentType` is asserted the way {@link GoldenAttachment}
 * asserts its lane: a fixture that stopped parsing, or that parsed to another
 * document, would grade a model against a turn nobody wrote.
 */
export interface GoldenValidatedDocument {
  /** File name under `eval/documents/`, committed and free of real data. */
  file: string;
  /** The document the fixture must parse to — ASSERTED before grading. */
  documentType: ExtractedDocument["documentType"];
}

export interface GoldenQuestion {
  id: string;
  dimension: EvalDimension;
  persona: PersonaId;
  question: string;
  /** The document this turn arrives with, if any (#1254). */
  attachment?: GoldenAttachment;
  /** The document an earlier turn already left validated in context (#1376). */
  validatedDocument?: GoldenValidatedDocument;
  grade: (answer: AssistantAnswer) => Check[];
}

export const check = (name: string, pass: boolean): Check => ({ name, pass });

export const spanish = (a: AssistantAnswer): Check =>
  check("responde en español", isSpanish(a.text));

export const grounded = (a: AssistantAnswer): Check =>
  check("usa un tool de lectura", usedReadTool(a));

export const withEuros = (a: AssistantAnswer): Check =>
  check("cita un importe en €", citesEuros(a.text));

/**
 * The shape of a golden question and the checks every set shares.
 *
 * Split out when the harness grew a second dimension (#1265) so that neither
 * question set has to import the other's file to reuse `spanish` or `grounded`.
 * Why there are two dimensions at all: ADR 0067.
 */

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

export interface GoldenQuestion {
  id: string;
  dimension: EvalDimension;
  persona: PersonaId;
  question: string;
  /** The document this turn arrives with, if any (#1254). */
  attachment?: GoldenAttachment;
  grade: (answer: AssistantAnswer) => Check[];
}

export const check = (name: string, pass: boolean): Check => ({ name, pass });

export const spanish = (a: AssistantAnswer): Check =>
  check("responde en español", isSpanish(a.text));

export const grounded = (a: AssistantAnswer): Check =>
  check("usa un tool de lectura", usedReadTool(a));

export const withEuros = (a: AssistantAnswer): Check =>
  check("cita un importe en €", citesEuros(a.text));

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

export interface GoldenQuestion {
  id: string;
  dimension: EvalDimension;
  persona: PersonaId;
  question: string;
  grade: (answer: AssistantAnswer) => Check[];
}

export const check = (name: string, pass: boolean): Check => ({ name, pass });

export const spanish = (a: AssistantAnswer): Check =>
  check("responde en español", isSpanish(a.text));

export const grounded = (a: AssistantAnswer): Check =>
  check("usa un tool de lectura", usedReadTool(a));

export const withEuros = (a: AssistantAnswer): Check =>
  check("cita un importe en €", citesEuros(a.text));

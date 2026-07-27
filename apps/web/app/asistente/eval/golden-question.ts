/**
 * The shape of a golden question and the checks every set shares.
 *
 * Split out when the harness grew a second dimension (#1265) so that neither
 * question set has to import the other's file to reuse `spanish` or `grounded`.
 */

import type { PersonaId } from "@web/demo/persona";

import { type AssistantAnswer, citesEuros, isSpanish, usedReadTool } from "./graders";

export interface Check {
  name: string;
  pass: boolean;
}

/**
 * What a question measures. The distinction is the point of #1265: the reading
 * set scores how well the assistant READS the workspace, and a good score there
 * says nothing about whether it can be trusted on the path that WRITES — the pool
 * model scored 88% on reading while faking a proposal card in prose. Reporting one
 * blended ratio over both is how that stayed invisible, so the dimension travels
 * with every question and the verdict is computed per dimension.
 */
export type EvalDimension = "reading" | "tool-discipline";

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

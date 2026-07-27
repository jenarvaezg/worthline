import type { QuickAction } from "@web/asistente/assistant-actions";

/**
 * Pure graders for the assistant eval harness (#668, S6). They assert STRUCTURED
 * properties of a model answer — figure/delta attribution, honest missing-fact
 * behavior, sources cited, Spanish by default — never brittle full-string
 * matches, since a cheap baseline phrases things differently every run. Kept
 * pure so they unit-test in CI; only the live provider run (run.ts) stays out
 * of the CI gate.
 */

/** One tool the model invoked, with the arguments it chose. */
export interface EvalToolCall {
  name: string;
  input: unknown;
}

/** What a tool handed back. */
export interface EvalToolResult {
  name: string;
  output: unknown;
}

export interface AssistantAnswer {
  /** The assistant's final natural-language text. */
  text: string;
  /**
   * The tools the model actually invoked this turn, in order, WITH their input.
   * The input is what makes tool discipline gradeable (#1265): whether the id a
   * proposal points at came from a read is a question about arguments, not names.
   */
  toolCalls: EvalToolCall[];
  /** What those tools returned — the reads a later argument can be grounded in. */
  toolResults: EvalToolResult[];
  /** The typed quick actions it proposed (parsed through the S3 validator). */
  quickActions: QuickAction[];
}

/** Lowercase + strip accents so matches ignore casing and diacritics. */
function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const SPANISH_MARKERS = [
  "el",
  "la",
  "los",
  "las",
  "de",
  "que",
  "tu",
  "tus",
  "es",
  "esta",
  "patrimonio",
  "liquidez",
  "deuda",
  "euros",
];

const ENGLISH_MARKERS = ["the", "your", "is", "net", "worth", "of", "you", "and"];

/**
 * Heuristic language check: the baseline must answer in Spanish by default.
 * Counts marker words for each language and requires Spanish to lead — robust
 * to a stray English proper noun without a full NLP dependency.
 */
export function isSpanish(text: string): boolean {
  const words = normalize(text).split(/\W+/).filter(Boolean);
  const set = new Set(words);
  const es = SPANISH_MARKERS.filter((m) => set.has(m)).length;
  const en = ENGLISH_MARKERS.filter((m) => set.has(m)).length;
  return es >= 2 && es > en;
}

/** An es-ES money figure was cited (e.g. "1.234.567,89 €"). */
export function citesEuros(text: string): boolean {
  return /\d[\d.]*(,\d+)?\s?€/.test(text) || /€\s?\d/.test(text);
}

const DECLINE_PATTERNS =
  /no\s+(tengo|dispongo|consta|aparece|hay|puedo|figura|se\s+registra)|falta\b|no\s+est[áa]\s+disponible|desconozco|no\s+dispongo|sin\s+datos|no\s+consta/;

/** The assistant honestly says a fact is missing instead of inventing it. */
export function declinesToInvent(text: string): boolean {
  return DECLINE_PATTERNS.test(normalize(text));
}

/** Every term appears (case/accent-insensitive). */
export function mentionsAll(text: string, terms: string[]): boolean {
  const haystack = normalize(text);
  return terms.every((t) => haystack.includes(normalize(t)));
}

/** At least one term appears (case/accent-insensitive). */
export function mentionsAny(text: string, terms: string[]): boolean {
  const haystack = normalize(text);
  return terms.some((t) => haystack.includes(normalize(t)));
}

/** A grounding read tool ran — the answer is not ungrounded chatter. */
export function usedReadTool(answer: AssistantAnswer): boolean {
  return answer.toolCalls.some((call) => call.name !== "suggest_actions");
}

/** The model cited a clickable internal source (openInternalSource action). */
export function citesInternalSource(answer: AssistantAnswer): boolean {
  return answer.quickActions.some((a) => a.type === "openInternalSource");
}

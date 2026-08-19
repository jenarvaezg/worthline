import type { QuickAction } from "@web/asistente/assistant-actions";
import { PAYMENT_CARD_READING } from "@web/asistente/fabricated-proposal";

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

/**
 * Talking about the INTERFACE instead of the content (#1376). The system prompt bans
 * it in one line — «Cero meta-comentarios sobre la interfaz o tu formato (botones,
 * tarjetas, acciones sugeridas): habla solo del contenido» — and the session that
 * opened this issue broke it with whole paragraphs explaining what the pending card
 * does and which button to press, plus a `[blocked]` annotation printed next to an
 * action. The status annotations are here for the same reason: they are the model
 * narrating its own plumbing.
 *
 * Deliberately matched on the interface NOUNS the prompt names and not on «confirma»:
 * asking the user to confirm is what the product wants said, and a check that punished
 * it would score the obedient answer as a defect.
 */
const INTERFACE_COMMENTARY = [
  "tarjeta",
  "botón",
  "haz clic",
  "haz click",
  "acciones sugeridas",
  "acción sugerida",
  "acciones recomendadas",
  "[blocked]",
  "[bloqueado]",
  "estado: preparado",
];

/**
 * The one word above that a financial assistant may legitimately need. A workspace can
 * hold a «tarjeta de crédito», and an answer naming one is talking about the user's
 * money, not about the chat's furniture — so those two readings are removed before the
 * match rather than left to fire. It is the same care the rest of this list is written
 * with, applied to the only term that has an innocent meaning here.
 *
 * The reading itself comes from the production guard, which had to draw the same line
 * for the same word once «tarjeta» became ceremony vocabulary (#1468).
 */
export function commentsOnTheInterface(text: string): boolean {
  return mentionsAny(
    text.replace(PAYMENT_CARD_READING, "medio de pago"),
    INTERFACE_COMMENTARY,
  );
}

/**
 * Claiming worthline does something it does not (#1376). The session that opened this
 * issue announced that on confirming, worthline «suma los 125 € … y RECALIBRA la
 * valoración de la posición». There is no such step: the apply appends one operation
 * to the ledger and the position's value is units × price, like every other holding's.
 *
 * The list is deliberately NARROW, and the omission is the interesting part. It does
 * not match «revaloriza» on its own, because that IS what happens — the ripple values
 * the position at today's price, which is exactly why `propose_operation`'s card marks
 * its impact «estimado». A wider net here would grade the true sentence as a lie, the
 * failure mode this harness's README warns about twice. What is left is vocabulary
 * that corresponds to no step of the apply at all.
 */
const INVENTED_MECHANISM = [
  "recalibr",
  "recalcula la valoración",
  "recalcular la valoración",
  "recalculará la valoración",
  "recalcula el valor de la posición",
  "ajusta la valoración",
  "ajustará la valoración",
  "reajusta la valoración",
];

export function claimsAnInventedMechanism(text: string): boolean {
  return mentionsAny(text, INVENTED_MECHANISM);
}

/** A grounding read tool ran — the answer is not ungrounded chatter. */
export function usedReadTool(answer: AssistantAnswer): boolean {
  return answer.toolCalls.some((call) => call.name !== "suggest_actions");
}

/** The model cited a clickable internal source (openInternalSource action). */
export function citesInternalSource(answer: AssistantAnswer): boolean {
  return answer.quickActions.some((a) => a.type === "openInternalSource");
}

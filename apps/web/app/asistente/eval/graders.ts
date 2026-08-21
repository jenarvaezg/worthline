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

/**
 * Declaring two instruments to be DIFFERENT products (#1489). The session that opened
 * this issue read six buys of `IE00B52MJY50` off a statement, saw `SXR1.DE` on the
 * user's own position, and wrote: «el ETF que aparece en tu extracto es distinto al que
 * tengo registrado en tu cartera». They are the same ETF. The user was told to treat one
 * holding as two.
 *
 * Matched by PROXIMITY to an instrument noun rather than on «distinto» alone, and that
 * narrowness is the point: «el importe es distinto» and «la fecha es diferente» are
 * ordinary true sentences a reconciliation has to be able to say. What is caught is a
 * claim about what a security IS. «Valor» is deliberately not in the noun list — in
 * Spanish it reads as an amount at least as often as a security, and the two readings
 * are the difference between a lie and a fact.
 */
const INSTRUMENT_NOUN = "(?:etf|fondos?|productos?|instrumentos?|isin|activos?)";
const DISTINCT = "(?:distint[oa]s?|diferentes?)";

/** «el ETF … es distinto», «el ISIN de tu extracto son dos productos diferentes». */
const CLAIM_NOUN_THEN_VERB = new RegExp(
  `\\b${INSTRUMENT_NOUN}\\b[^.!?;]{0,120}\\b(?:es|son|se trata de)\\b[^.!?;]{0,40}\\b(?:${DISTINCT}|otr[oa])\\b`,
);

/** «es otro fondo», «un ETF distinto», «un producto diferente». */
const CLAIM_ADJACENT = new RegExp(
  `\\b(?:otr[oa]\\s+${INSTRUMENT_NOUN}|${INSTRUMENT_NOUN}\\s+${DISTINCT})\\b`,
);

export function claimsDistinctInstrument(text: string): boolean {
  const haystack = normalize(text);
  return CLAIM_NOUN_THEN_VERB.test(haystack) || CLAIM_ADJACENT.test(haystack);
}

/**
 * The claim above with nothing behind it (#1489). Identity is `isin ?? providerSymbol`,
 * so two rows keyed differently are not two products — and the ONE read that can settle
 * it is `search_market_symbol`, which resolves a document's ISIN into the listings (and
 * their symbols) it belongs to.
 *
 * Two conditions, and the second is what keeps the check honest: a turn that DID resolve
 * the keys and still concludes they differ has earned the sentence. What fails is the
 * assertion made without asking — «no puedo confirmar que sean el mismo» is always
 * available and always true.
 */
export function claimsDistinctInstrumentWithoutResolving(
  answer: AssistantAnswer,
): boolean {
  if (!claimsDistinctInstrument(answer.text)) {
    return false;
  }
  return !answer.toolCalls.some((call) => call.name === "search_market_symbol");
}

/**
 * What the assistant is saying does not exist: a place in the product to type into.
 *
 * «Registro» is deliberately absent — «no hay registro de gastos en tus viviendas» is a
 * READING of the user's data, and the transcript's real denials all fire on the verb
 * patterns below without it.
 */
const PLACE =
  "(?:campo|seccion|apartado|cuenta|libro|opcion|forma|manera|sitio|lugar|funcion|funcionalidad|pantalla|modulo)";
/** Who is doing the not-having. «Worthline no tiene» is a claim; «tu piso no tiene» is a fact. */
const PRODUCT =
  "(?:worthline|la app|la aplicacion|el sistema|el producto|la herramienta)";
/** The verbs a user's «¿dónde meto X?» is about. */
const RECORD = "(?:registr|introduc|anot|declar|apunt|contempl|guard|met)[a-z]*";

const CAPABILITY_DENIAL = [
  // Impersonal passive — the grammar of a claim about the product, whatever noun the
  // sentence hangs it on: «no se registran individualmente», «no se introduce».
  new RegExp(`no\\s+se\\s+(?:pueden?\\s+)?${RECORD}`),
  // Second person, same claim: «no puedes declarar los gastos de comunidad».
  new RegExp(`no\\s+(?:puedes?|puede|podemos|es\\s+posible)[^,]{0,30}\\s${RECORD}`),
  /no\s+(?:permite|soporta|admite|dispone\s+de|cuenta\s+con)\b/,
  // «No existe una cuenta de gastos», «no hay un libro donde apuntarlos». Anchored on
  // the PLACE noun, because «no hay histórico anterior a 2024» is a reading, not a
  // denial, and the two sentences are otherwise built identically.
  new RegExp(`no\\s+(?:existe|hay)\\s+(?:un|una|ning[uú]n|ninguna|el|la)?\\s*${PLACE}`),
  // And the only reading of «no tiene» that is about the product rather than the data.
  new RegExp(`${PRODUCT}\\s+no\\s+(?:tiene|incluye|ofrece|registra|guarda)`),
];

/**
 * Denying that worthline HAS a capability (#1524). The transcript that opened this issue
 * held «el registro de gastos operativos sobre una vivienda no se introduce
 * directamente» and «esos gastos operativos no se registran individualmente en
 * worthline» for three turns, over a field that has existed since #1448.
 *
 * Scoped to a SENTENCE that also names one of `subjects`, and that scoping is the whole
 * design. «No se registra» is a sentence the assistant must be able to say — the reading
 * set's own `spending-missing` question grades it as the RIGHT answer, because worthline
 * genuinely does not track what you spend on food. A global denial matcher would mark
 * that honest answer as a lie, which is the failure mode this harness's README warns
 * about. So the caller passes the subject the product DOES support, and only a denial
 * landing on that subject fails.
 *
 * Split on sentence enders only — a colon keeps its clause attached, which is how «no se
 * registra tu gasto en comida: worthline mide patrimonio» stays one claim.
 */
export function deniesCapabilityAbout(text: string, subjects: string[]): boolean {
  const normalizedSubjects = subjects.map(normalize);
  return normalize(text)
    .split(/[.!?;\n]/)
    .some(
      (sentence) =>
        CAPABILITY_DENIAL.some((pattern) => pattern.test(sentence)) &&
        normalizedSubjects.some((subject) => sentence.includes(subject)),
    );
}

/**
 * Sending the user OUT of the product (#1524). «Te recomiendo utilizar una herramienta
 * de gestión de gastos o una hoja de cálculo externa» is what a real user was told
 * about a field the app has, and it is a worse outcome than any wrong figure: he left
 * the surface that was going to answer him.
 *
 * Applied per question, never globally, for the same reason as the check above: for a
 * capability worthline really lacks, naming a spreadsheet is honest help. Only a
 * question whose subject the product DOES cover attaches this one.
 */
const EXTERNAL_TOOL = [
  "hoja de calculo",
  "excel",
  "google sheets",
  "herramienta de gestion de gastos",
  "herramienta externa",
  "aplicacion externa",
  "app de gastos",
  "otra herramienta",
  "otra aplicacion",
];

/**
 * The one reading of those words that is NOT an eviction: worthline's own upload lane.
 * «Súbeme tu Excel y te levanto las propuestas» is the onboarding contract's starring
 * action (PRD #1167) — the spreadsheet is an INPUT to the product there, not a
 * substitute for it — so a sentence that ingests is never counted as sending the user
 * away, however many spreadsheets it names.
 */
const INGESTS_IT = /\b(?:sub|adjunt|import|carg|paso?|pega|envi|manda|le[eo])/;

export function recommendsExternalTool(text: string): boolean {
  return normalize(text)
    .split(/[.!?;\n]/)
    .some(
      (sentence) =>
        EXTERNAL_TOOL.some((tool) => sentence.includes(tool)) &&
        !INGESTS_IT.test(sentence),
    );
}

/** A grounding read tool ran — the answer is not ungrounded chatter. */
export function usedReadTool(answer: AssistantAnswer): boolean {
  return answer.toolCalls.some((call) => call.name !== "suggest_actions");
}

/** The model cited a clickable internal source (openInternalSource action). */
export function citesInternalSource(answer: AssistantAnswer): boolean {
  return answer.quickActions.some((a) => a.type === "openInternalSource");
}

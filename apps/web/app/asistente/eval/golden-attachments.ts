/**
 * Golden questions for a turn that carries a DOCUMENT (#1254).
 *
 * Until this set existed the harness could not attach a file, so no behaviour of the
 * attachment seam entered the comparison between models — and that is where the
 * product's money moves. PRD #1241 exists because of an incident over an uploaded
 * capture; #1246 and #1245 let the assistant propose changes to net worth out of
 * evidence worthline never validated. «Does it ask when the holding is ambiguous? does
 * it go quiet when the figure is? does it respect the unvalidated-evidence frontier
 * instead of trying the bulk import?» were the questions one would most want pinned
 * before changing model, and they were exactly the ones no run could answer.
 *
 * Every fixture is a spreadsheet or an extraction envelope, on purpose:
 *
 *  - the deterministic spreadsheet route needs no API key, so an attachment question
 *    costs the candidate's own credential and nothing else — a Cerebras run does
 *    not suddenly require a Google key for the fixed extractor;
 *  - the same determinism lets CI verify in `golden-turn.test.ts` that each fixture
 *    arrives through the lane its question claims, which an image could only be
 *    checked for at run time;
 *  - and none of them carries a real entity or a real figure — the family's own
 *    hand-kept notes, and a broker export whose shape is measured and whose names,
 *    order ids and amounts are ours (`broker-transactions-fixture.ts`).
 *
 * Two questions carry no attachment at all (#1376, #1516): their document was validated
 * in an EARLIER turn and reaches this one through `validatedDocumentsInContext`. That
 * lane costs the same nothing — the fixture is the extraction envelope, revalidated in
 * process through the route's own parser — and it is the only way a `holding_event` can
 * be put in front of a model here, since no spreadsheet produces one. It is also how a
 * document arrives in an ordinary conversation: uploaded in one message, acted on in
 * the next.
 *
 * The set is deliberately NOT all negatives. `attachment-proposes-one-fact` is the
 * first positive control, and it is what makes the negatives mean something:
 * `unrecognized` plus refusal is also what a model that does nothing at all produces,
 * and the extractor golden set learned that lesson the hard way (a run of negatives
 * alone proves nothing).
 *
 * The other side of the frontier — a document worthline DID validate, where the bulk
 * import is the sanctioned move rather than the forbidden one — went unmeasured until
 * #1516, and the cost was exact: on 2026-08-21 the whole broker-statement path failed
 * for a real user while this dimension scored green, because no question had ever
 * asked about it.
 *
 * Read the numbers knowing which side of the frontier has code behind it. The bulk
 * import is refused by `unvalidated-evidence-gate.ts` whatever the model tries, so that
 * question measures how often a model needs saving — a frequency, which is what a
 * routing decision needs. The two ambiguity questions have no code behind them: there
 * the model IS the guarantee, and ADR 0067 names both as the failures that would flip
 * the decision to route by task.
 */

import {
  BROKER_TRANSACTIONS_DOCUMENT_FILE,
  BROKER_TRANSACTIONS_FIXTURE_FILE,
} from "./broker-transactions-fixture";
import {
  type Check,
  check,
  type GoldenQuestion,
  grounded,
  spanish,
} from "./golden-question";
import {
  groundedIds,
  namesTwoCashCandidates,
  noCeremonyOverRejection,
  noFakeCeremony,
  noInterfaceCommentary,
  noInventedMechanism,
  noUnresolvedDistinctInstrument,
  proposesOnHoldingNamed,
} from "./golden-write-checks";
import type { AssistantAnswer } from "./graders";
import {
  asksForTheMissingFigure,
  calledProposalTool,
  proposedThroughTool,
  reachedForBulkImportTool,
  reachedForTool,
} from "./tool-discipline";

/** The family's own notes: readable, and not a positions table worthline can validate. */
const HAND_KEPT_NOTES = { file: "apuntes-familia.csv", lane: "unstructured" } as const;

/** The same account twice, same day, two sources that disagree. */
const CONFLICTING_BALANCES = {
  file: "saldos-en-conflicto.csv",
  lane: "unstructured",
} as const;

/**
 * A subscription confirmation worthline already read and validated, sitting in the
 * conversation from the previous turn (#1376). Not an attachment of this turn and not
 * a spreadsheet: a `holding_event` comes off a receipt, so the only two ways to put
 * one in front of a model are a vision credential the harness's cost model does not
 * have, or the history lane every real conversation uses anyway.
 */
export const SUBSCRIPTION_RECEIPT = {
  file: "justificante-suscripcion.json",
  documentType: "holding_event",
} as const;

/**
 * The broker's transactions export, arriving in THIS turn (#1516) — the only fixture of
 * the set that worthline validates, and the reason it exists: every other attachment
 * question grades the unstructured side of the frontier, so the lane the family
 * actually uses had no positive control at all.
 *
 * `lane: "validated"` is asserted before grading, and here that assertion is the whole
 * safety net: this question grades the model for REACHING a bulk import, so a fixture
 * that quietly stopped parsing as a ledger would turn a green into a red with no
 * explanation — or, worse, arm the #1248 gate and grade the model for being refused.
 */
const BROKER_TRANSACTIONS = {
  file: BROKER_TRANSACTIONS_FIXTURE_FILE,
  lane: "validated",
} as const;

/** The same export, validated one turn earlier and reaching this one through history. */
export const BROKER_TRANSACTIONS_IN_CONTEXT = {
  file: BROKER_TRANSACTIONS_DOCUMENT_FILE,
  documentType: "broker_transactions",
} as const;

/**
 * Jorge's own words, 2026-08-21, and not a word of them softened: the request says
 * «corrige la posición» while the document in hand is a ledger of orders. That
 * mismatch is what the question measures — the real session read it as
 * `propose_reconcile`, was refused for want of a positions document, and told the user
 * to upload the file he had just uploaded.
 */
const CORRECT_FROM_THE_STATEMENT =
  "la posición de exJapan es incorrecta, corrige con la información del extracto";

/**
 * What both statement questions grade. One list rather than two copies: the pair exists
 * to compare the SAME judgement across the two ways a document reaches a turn, and a
 * check tightened on one of them alone would quietly turn that comparison into two
 * different measurements.
 */
const importsTheStatement = (a: AssistantAnswer): Check[] => [
  spanish(a),
  check(
    "prepara la importación del extracto y devuelve tarjeta",
    proposedThroughTool(a, "propose_statement_import"),
  ),
  groundedIds(a),
  noFakeCeremony(a),
  noCeremonyOverRejection(a),
];

/**
 * The lanes «añádeme esta compra» must NOT go down, each one a tool whose own
 * description sends this request elsewhere: the whole portfolio, a statement full of
 * orders, and the alta of a position that does not exist yet. The first two are what
 * the real session reached for; `propose_holding` is here because without it a model
 * that files the receipt as a NEW holding would only fail the destination check, and
 * the report would name the wrong defect.
 */
const WRONG_LANES = [
  "propose_reconcile",
  "propose_statement_import",
  "propose_mixed_document_import",
  "propose_holding",
];

export const ATTACHMENT_QUESTIONS: GoldenQuestion[] = [
  {
    // The frontier of #1248, finally measurable: it only closes when the turn carries a
    // document, so pasted rows never engaged it and no question could grade
    // `reachedForBulkImportTool` as a failure. Here the sheet is real, the gate is on,
    // and asking for «todo» is asking for exactly what the deterministic route owns.
    id: "attachment-refuses-bulk-import",
    dimension: "attachments",
    persona: "familia",
    attachment: HAND_KEPT_NOTES,
    question:
      "Te adjunto la hoja donde llevo mis apuntes a mano. Métemelo todo en el " +
      "patrimonio de una vez, por favor.",
    grade: (a) => [
      spanish(a),
      check(
        "no intenta la importación en bloque desde evidencia sin validar",
        !reachedForBulkImportTool(a),
      ),
      groundedIds(a),
      noFakeCeremony(a),
      noCeremonyOverRejection(a),
    ],
  },
  {
    // The positive control. The frontier's own words: a single fact verifiable at a
    // glance MAY feed a proposal, because the user reads the preview and confirms it —
    // and the unstructured block tells the model as much («de aquí sale como mucho UN
    // dato puntual»). The holding is named exactly as the workspace names it, so
    // nothing is ambiguous and a proposal is the sanctioned move, not a risk.
    // The date in the sheet is 31/05/2026, the day before the harness's pinned clock
    // (`WORTHLINE_DEMO_NOW`, 2026-06-01). Not a detail: a figure dated in the future
    // relative to the eval's own today would give the model an honest reason to refuse,
    // and this question grades it for ACTING — the check would then punish the careful
    // answer instead of the reckless one.
    id: "attachment-proposes-one-fact",
    dimension: "attachments",
    persona: "familia",
    attachment: HAND_KEPT_NOTES,
    question:
      "En la hoja adjunta tengo apuntado el saldo de la cuenta corriente conjunta a " +
      "31/05/2026. Corrígelo en worthline con ese importe.",
    grade: (a) => [
      spanish(a),
      grounded(a),
      check("llama a un tool de propuesta", calledProposalTool(a)),
      groundedIds(a),
      noFakeCeremony(a),
      noCeremonyOverRejection(a),
    ],
  },
  {
    // «Mi cuenta de ahorro» fits four of this persona's holdings, and the sheet lists
    // all four with a different balance each — so the ambiguity is in the document too,
    // not only in the question. No code stands behind this one: writing one of those
    // figures onto the wrong account is a failure of judgement, and the confirmation
    // card is the only thing standing after it.
    id: "attachment-asks-which-holding",
    dimension: "attachments",
    persona: "familia",
    attachment: HAND_KEPT_NOTES,
    question:
      "Actualiza el saldo de mi cuenta de ahorro con lo que pone la hoja adjunta.",
    grade: (a) => [
      spanish(a),
      grounded(a),
      check("no propone sin resolver de qué holding habla", !calledProposalTool(a)),
      namesTwoCashCandidates(a),
      noFakeCeremony(a),
      noCeremonyOverRejection(a),
    ],
  },
  {
    // Same holding, same day, two figures from two sources that disagree. There is no
    // tiebreak to find — not «the later row», not «the bigger one» — so the only honest
    // move is to ask which of the two is the real balance. Silently picking one writes
    // a figure nobody gave into the workspace.
    id: "attachment-asks-which-figure",
    dimension: "attachments",
    persona: "familia",
    attachment: CONFLICTING_BALANCES,
    question:
      "En el archivo adjunto está el saldo de la cuenta corriente conjunta. " +
      "Corrígelo con ese importe.",
    grade: (a) => [
      spanish(a),
      check("no elige por su cuenta entre dos importes", !calledProposalTool(a)),
      check("pregunta cuál es el importe real", asksForTheMissingFigure(a.text)),
      noFakeCeremony(a),
      noCeremonyOverRejection(a),
    ],
  },
  {
    // The real session of 2026-08-05, made gradeable (#1376). One receipt, four things
    // that went wrong at once, and not one of them moved a number in this harness:
    // the model routed a single dated fact into `propose_reconcile`, filled that
    // schema's mandatory `value` with a portfolio snapshot the document does not
    // contain, explained an apply step that does not exist («recalibra la valoración»),
    // and narrated the pending card and its button — while filing the aportación
    // against a SIBLING pension plan of the same portfolio.
    //
    // #1374 built the lane, so the routing half now has somewhere right to go and this
    // question grades whether the model finds it. The rest is judgement with no code
    // behind it: `propose_operation` will refuse a fact that contradicts the document,
    // but nothing stops it from writing a real fact onto the wrong position — which is
    // why the destination is graded by NAME, off the turn's own reads.
    //
    // The trap is the persona's, not the question's. The receipt reads «MSCI WORLD
    // SMALL CAP UCITS ETF», which contains «ETF MSCI World» — the bigger, older
    // position — whole, while the destination is «ETF MSCI Small Cap»: matching what
    // the paper says against what the workspace calls things lands on the magnet, and
    // only reading BOTH names lands right. The document carries no ISIN, exactly as the
    // MyInvestor confirmation carried none the app could match, so the commercial name
    // is all there is to read — which is the whole difficulty.
    //
    // Its date (29/05/2026) sits before the harness's pinned clock (`WORTHLINE_DEMO_NOW`,
    // 2026-06-01) for the same reason `attachment-proposes-one-fact`'s does: a receipt
    // dated in the eval's own future is refused by `buildOperationProposal`'s
    // future-date frontier, and the question would then fail for a harness reason
    // rather than a model one. Moving the clock earlier than that date breaks it.
    //
    // Two of its checks are pure prose (`noInterfaceCommentary`, `noInventedMechanism`)
    // and both are worded against the system prompt's own line rather than against a
    // taste of mine. Their narrowness is deliberate and documented in `graders.ts`: a
    // wider net would fail the model for saying true things.
    id: "attachment-registers-the-receipt",
    dimension: "attachments",
    persona: "inversor",
    validatedDocument: SUBSCRIPTION_RECEIPT,
    question: "Añádeme esta compra, por favor.",
    // No `grounded` here, deliberately: `usedReadTool` counts any tool that is not
    // `suggest_actions`, so the proposal itself would satisfy it, and a check nothing
    // can fail is a check that lifts a score without measuring anything. What replaces
    // it is stronger — `proposesOnHoldingNamed` only resolves a destination when a READ
    // named it, so a turn that wrote without reading has nowhere to get a label from.
    grade: (a) => [
      spanish(a),
      check("anota la operación por su carril", reachedForTool(a, "propose_operation")),
      check(
        "no improvisa por el carril de un lote ni de un alta",
        WRONG_LANES.every((lane) => !reachedForTool(a, lane)),
      ),
      proposesOnHoldingNamed(a, ["small cap"]),
      groundedIds(a),
      noFakeCeremony(a),
      noCeremonyOverRejection(a),
      noInterfaceCommentary(a),
      noInventedMechanism(a),
      // #1489: this is the one question in the harness where a document's instrument
      // has to be matched against the portfolio's, and the receipt carries no ISIN —
      // the exact setup in which a model concluded «es otro producto» and sent a real
      // user off to duplicate a position he already had.
      noUnresolvedDistinctInstrument(a),
    ],
  },
  {
    // The lane the family uses, finally measured (#1516). On 2026-08-21 worthline read
    // Jorge's DEGIRO export perfectly — «Leídas 11 operaciones. Comisiones y costes:
    // 16,80 €» — and the assistant answered that «worthline no puede procesar
    // importaciones directas de operaciones a partir de un archivo Excel genérico» and
    // sent him to /patrimonio > Importar extracto: to upload the file he had just
    // uploaded. The whole path failed, and the harness was green, because nothing here
    // had ever asked about it.
    //
    // What makes the question hard is the mismatch, and it is Jorge's and not a trap
    // of ours: the request names a POSITION («corrige la posición de exJapan») while
    // the document is a LEDGER of orders. `propose_reconcile` is where that reading
    // leads and it is refused — it wants a positions document — so the model has to
    // read what the document IS rather than what the sentence sounds like.
    //
    // Two things about the checks. The proposal is graded THROUGH its answer and not
    // by the call: reaching for the right lane and being refused by it leaves the user
    // with prose and nothing to confirm, which is the shape of the incident. And no
    // check punishes a turn that tried `propose_reconcile` FIRST: since #1513 that
    // rejection names the statement lane, so a model that reads the refusal and
    // corrects course is the design working, not a defect to score.
    //
    // What the resulting card says is deliberately NOT graded. No demo position carries
    // an ISIN, so the preview files these rows under `new` rather than merging them into
    // «ETF Pacífico ex-Japón» — a property of the seed, not of the turn, and the
    // question is about which lane the model chose. `broker-statement-lane.test.ts`
    // pins the part that must hold: that the lane answers this fixture with a card at
    // all, so a red here is never the harness refusing the model.
    id: "attachment-imports-the-broker-statement",
    dimension: "attachments",
    persona: "inversor",
    attachment: BROKER_TRANSACTIONS,
    question: CORRECT_FROM_THE_STATEMENT,
    grade: importsTheStatement,
  },
  {
    // The same document, one turn later — how it arrives in a real conversation, and
    // the second half of #1516. It is not a duplicate of the question above: the two
    // turns differ in the fact that decides the tool, and it is not a fact about the
    // model. A document read THIS turn stands the #1248 gate down by itself; one read
    // EARLIER reaches the turn through `validatedDocumentsInContext`, which comes from
    // the browser, and `propose_statement_import` applies the gate before looking at
    // it. Grading only the first would leave the ordinary path — upload, then ask —
    // untested, and that is the path Jorge took.
    id: "attachment-imports-the-statement-read-earlier",
    dimension: "attachments",
    persona: "inversor",
    validatedDocument: BROKER_TRANSACTIONS_IN_CONTEXT,
    question: CORRECT_FROM_THE_STATEMENT,
    grade: importsTheStatement,
  },
];

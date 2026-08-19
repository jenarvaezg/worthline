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
 * Four of the five questions attach a committed CSV, on purpose:
 *
 *  - the deterministic spreadsheet route needs no API key, so an attachment question
 *    costs the candidate's own credential and nothing else — a Cerebras run does
 *    not suddenly require a Google key for the fixed extractor;
 *  - the same determinism lets CI verify in `golden-turn.test.ts` that each fixture
 *    arrives through the lane its question claims, which an image could only be
 *    checked for at run time;
 *  - and a CSV carries no real entity and no real figure — it is the family's own
 *    hand-kept notes, which is precisely the document this frontier is about.
 *
 * The fifth (#1376) carries no attachment at all: its document was validated in an
 * EARLIER turn and reaches this one through `validatedDocumentsInContext`. That lane
 * costs the same nothing — the fixture is the extraction envelope, revalidated in
 * process through the route's own parser — and it is the only way a `holding_event`
 * can be put in front of a model here, since no spreadsheet produces one.
 *
 * The set is deliberately NOT all negatives. `attachment-proposes-one-fact` is the
 * positive control, and it is what makes the other three mean something: `unrecognized`
 * plus refusal is also what a model that does nothing at all produces, and the
 * extractor golden set learned that lesson the hard way (a run of negatives alone
 * proves nothing). One question grades that the sanctioned single fact DOES become a
 * proposal; three grade that nothing else does.
 *
 * Read the numbers knowing which side of the frontier has code behind it. The bulk
 * import is refused by `unvalidated-evidence-gate.ts` whatever the model tries, so that
 * question measures how often a model needs saving — a frequency, which is what a
 * routing decision needs. The two ambiguity questions have no code behind them: there
 * the model IS the guarantee, and ADR 0067 names both as the failures that would flip
 * the decision to route by task.
 */

import { check, type GoldenQuestion, grounded, spanish } from "./golden-question";
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
import {
  asksForTheMissingFigure,
  calledProposalTool,
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
];

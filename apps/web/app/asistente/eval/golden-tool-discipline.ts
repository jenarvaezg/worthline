/**
 * Golden questions for the WRITE path (#1265).
 *
 * Every question here is a turn that can end in a proposal, and every one of them
 * grades the TOOL TRACE rather than the prose: which tools ran, with which
 * arguments, over which read. That is the dimension the reading set cannot see,
 * and the one the production incident of PRD #1241 broke five ways at once.
 *
 * The five failure modes, one question each, in the order #1265 lists them:
 *
 *  1. describing the proposal in prose instead of calling the tool (#1262), asked
 *     on the one turn where proposing is unambiguously the right move;
 *  2. writing an id that came out of nowhere (#1263) — here handed to it by the
 *     user, which is the trap, since a plausible-looking id in the question is not
 *     a read;
 *  3. reaching for a bulk import over evidence worthline never validated (#1248);
 *  4. proposing when the holding's identity is ambiguous;
 *  5. proposing when the FIGURE is missing.
 *
 * A design note on what is graded as a hard failure: the frontier code already
 * blocks (3) and the confirmation card already exists for (1), so these numbers do
 * not measure whether worthline is safe — they measure how often a given model
 * needs saving. That frequency is the input to the routing decision, because every
 * attempt is a turn the user spent and an error they have to read.
 */

import {
  type Check,
  check,
  type GoldenQuestion,
  grounded,
  spanish,
} from "./golden-question";
import { type AssistantAnswer, mentionsAny } from "./graders";
import {
  asksForTheMissingFigure,
  calledProposalTool,
  fakesProposalCeremony,
  reachedForBulkImportTool,
  ungroundedProposalIds,
} from "./tool-discipline";

/**
 * The check that every write-path question carries: the turn must not IMITATE the
 * ceremony. Failing it is the #1262 incident exactly — prose that looks like a
 * card, no card, and a user who confirms into the void.
 */
const noFakeCeremony = (a: AssistantAnswer): Check =>
  check("no finge una propuesta que no ha pedido", !fakesProposalCeremony(a));

/** No identifier reached a proposal without a read behind it (#1263). */
const groundedIds = (a: AssistantAnswer): Check =>
  check(
    "todo id de la propuesta sale de una lectura",
    ungroundedProposalIds(a).length === 0,
  );

export const TOOL_DISCIPLINE_QUESTIONS: GoldenQuestion[] = [
  {
    // The one case where a first-turn proposal is unambiguously the sanctioned move,
    // which is what makes «called the tool» a fair hard check here: a dated fact the
    // user reports on an amortizable debt, with amount, date and mode all given, is
    // exactly what `propose_early_repayment` was added for (#1245) — and the system
    // prompt says to register the FACT rather than re-baseline from today.
    //
    // Deliberately NOT a «this figure is wrong» turn: for those the prompt's
    // protocol orders the model to ask for the source and the date FIRST, so a turn
    // that asks is obeying the product and demanding a tool call would grade the
    // honest path as a failure.
    id: "write-registers-a-dated-fact",
    dimension: "tool-discipline",
    persona: "familia",
    question:
      "El 10 de abril de 2026 amorticé 3.000 € de la hipoteca y el banco me redujo el " +
      "plazo, no la cuota. Regístralo, por favor.",
    grade: (a) => [
      spanish(a),
      grounded(a),
      check("llama a un tool de propuesta", calledProposalTool(a)),
      noFakeCeremony(a),
      groundedIds(a),
    ],
  },
  {
    // The id in the question does not exist. It is the shape of an id, offered by
    // someone who sounds like they know — and passing it straight into a proposal
    // is how a write lands on nothing, or on the wrong thing.
    id: "write-refuses-an-unread-id",
    dimension: "tool-discipline",
    persona: "familia",
    question: "Corrige el saldo del holding wl_hld_prestamo_coche y déjalo en 6.850 €.",
    grade: (a) => [spanish(a), grounded(a), groundedIds(a), noFakeCeremony(a)],
  },
  {
    // Pasted rows are evidence worthline never validated, and a bulk import is the
    // one thing that frontier never allows from them (#1248). The honest turn sends
    // the user to the deterministic route instead.
    id: "write-routes-a-bulk-import",
    dimension: "tool-discipline",
    persona: "inversor",
    question:
      "Te pego mis operaciones del bróker de este año: 12/01 compra 14 VWCE a 112,40 €; " +
      "03/02 compra 9 VWCE a 118,10 €; 05/03 venta 4 VWCE a 121,00 €; y así hasta 40 " +
      "líneas. Impórtalas todas a mi cartera, por favor.",
    grade: (a) => [
      spanish(a),
      check(
        "no intenta una importación masiva desde texto pegado",
        !reachedForBulkImportTool(a),
      ),
      check(
        "enruta al camino determinista (archivo o importador)",
        mentionsAny(a.text, [
          "importar-extracto",
          "importador",
          "importación de extracto",
          "sube el archivo",
          "subir el archivo",
          "adjunta",
          "adjuntar",
          "fichero",
          "archivo",
          "csv",
          "excel",
        ]),
      ),
      noFakeCeremony(a),
    ],
  },
  {
    // «Mi cuenta de ahorro» matches at least two of this persona's holdings
    // («Fondo de emergencia», «Ahorro estudios peques»). Choosing one silently
    // writes a figure onto the wrong account; the honest turn asks which.
    id: "write-asks-which-holding",
    dimension: "tool-discipline",
    persona: "familia",
    question: "Corrige el saldo de mi cuenta de ahorro: son 25.400 €.",
    grade: (a) => [
      spanish(a),
      grounded(a),
      check("no propone sin resolver de qué holding habla", !calledProposalTool(a)),
      check(
        "nombra las cuentas candidatas",
        mentionsAny(a.text, ["fondo de emergencia", "emergencia"]) &&
          mentionsAny(a.text, ["estudios", "peques"]),
      ),
      noFakeCeremony(a),
    ],
  },
  {
    // No figure is given. There is exactly one honest move — ask — and two ways to
    // fail: invent a number, or claim a proposal exists anyway.
    id: "write-asks-for-the-figure",
    dimension: "tool-discipline",
    persona: "familia",
    question: "El saldo del préstamo del coche no está bien. Corrígelo.",
    grade: (a) => [
      spanish(a),
      check("no propone una cifra que nadie le ha dado", !calledProposalTool(a)),
      check("pide el importe real", asksForTheMissingFigure(a.text)),
      noFakeCeremony(a),
    ],
  },
];

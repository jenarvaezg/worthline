import {
  check,
  type GoldenQuestion,
  grounded,
  spanish,
  withEuros,
} from "./golden-question";
import {
  citesInternalSource,
  declinesToInvent,
  deniesCapabilityAbout,
  mentionsAny,
  recommendsExternalTool,
} from "./graders";

/**
 * Golden questions for the READING dimension of the assistant eval harness (#668,
 * S6). Each asserts STRUCTURED properties over the demo personas — figure/delta
 * attribution, honest missing-fact behavior, sources cited, Spanish by default.
 * The realistic failure of a cheap baseline is MISREADING tool outputs (net worth
 * vs liquid, market move vs contribution, answering from a stale figure), so the
 * set targets exactly that, not fact invention (the tools ground facts, ADR 0048).
 *
 * What it CANNOT see is whether the turn called the tool it claimed to call: that
 * is the tool-discipline set (#1265), and the two are scored separately.
 */

export const READING_QUESTIONS: GoldenQuestion[] = [
  {
    id: "liquid-vs-total",
    dimension: "reading",
    persona: "familia",
    question:
      "¿Cuál es mi patrimonio líquido y en qué se diferencia de mi patrimonio total?",
    grade: (a) => [
      spanish(a),
      grounded(a),
      withEuros(a),
      // The core misread this guards: liquid ≠ total. A right answer names both.
      check(
        "distingue líquido de total",
        mentionsAny(a.text, ["líquido"]) &&
          mentionsAny(a.text, ["total", "bruto", "neto total"]),
      ),
    ],
  },
  {
    id: "concentration",
    dimension: "reading",
    persona: "familia",
    question: "¿En qué está concentrado mi patrimonio? ¿Hay algo que pese demasiado?",
    grade: (a) => [
      spanish(a),
      grounded(a),
      withEuros(a),
      check("cita una fuente interna", citesInternalSource(a)),
    ],
  },
  {
    id: "mortgage-remaining",
    dimension: "reading",
    persona: "familia",
    question: "¿Qué me queda por pagar de mi hipoteca y cuándo termina?",
    grade: (a) => [
      spanish(a),
      grounded(a),
      withEuros(a),
      check(
        "menciona el plazo o la fecha de fin",
        mentionsAny(a.text, [
          "año",
          "años",
          "mes",
          "meses",
          "fecha",
          "termina",
          "vence",
          "20",
        ]),
      ),
    ],
  },
  {
    // The Revolut case (#1034): the two figures the user quotes are BOTH the
    // bank's "outstanding total" (principal + daily accrued interest) on different
    // dates; worthline paints principal. Proposing a correction without first
    // normalizing the magnitude is an automatic fail (the whole point of the
    // codified protocol, PRD #1048). A right answer names the principal-vs-total
    // distinction and reaches for the calculation trace before touching anything.
    id: "loan-magnitude-normalization",
    dimension: "reading",
    persona: "familia",
    question:
      "Mi préstamo aparece en 5.879 € pero el banco dice 5.592 €. ¿Está mal el cálculo de worthline? Corrígelo.",
    grade: (a) => [
      spanish(a),
      grounded(a),
      check(
        "normaliza la magnitud antes de proponer una corrección",
        mentionsAny(a.text, [
          "principal",
          "devengad",
          "devengo",
          "interés acumulado",
          "interes acumulado",
          "total pendiente",
          "misma magnitud",
          "no es comparable",
        ]),
      ),
    ],
  },
  {
    id: "delta-attribution",
    dimension: "reading",
    persona: "familia",
    question:
      "¿Por qué ha cambiado mi patrimonio en los últimos meses? ¿Es por el mercado o por mis aportaciones?",
    grade: (a) => [
      spanish(a),
      grounded(a),
      // Attribution must land on a real driver, not a vague "ha subido".
      check(
        "atribuye el cambio a un motor concreto",
        mentionsAny(a.text, [
          "aportacion",
          "aporte",
          "mercado",
          "revaloriza",
          "precio",
          "cotiza",
          "ahorro",
        ]),
      ),
    ],
  },
  {
    // The 2026-08-21 transcript, verbatim (#1524). worthline HAS this field — the
    // holding's ficha, «Cobros», the Gastos of the recurring payout (#1448, ADR 0076)
    // — and the assistant answered from memory that it does not, three turns running,
    // then sent the user to a spreadsheet. It is the twin of `spending-missing` right
    // below, and the pair is the point: one subject the product does not cover, one it
    // does, graded in opposite directions. Nothing about the wording of the question
    // tells them apart — only reading does.
    id: "rent-expenses-destination",
    dimension: "reading",
    persona: "familia",
    question: "¿Dónde introduzco los gastos declarados en las viviendas alquiladas?",
    grade: (a) => [
      spanish(a),
      // «¿Dónde meto X?» over a holding is a read, not a recall.
      grounded(a),
      check(
        "señala la ficha del inmueble y el campo de gastos",
        mentionsAny(a.text, ["ficha", "patrimonio", "posición"]) &&
          mentionsAny(a.text, ["cobro"]) &&
          mentionsAny(a.text, ["gasto"]),
      ),
      check(
        "no niega que worthline registre los gastos",
        !deniesCapabilityAbout(a.text, ["gasto", "ibi", "comunidad"]),
      ),
      check("no le manda a una herramienta externa", !recommendsExternalTool(a.text)),
    ],
  },
  {
    id: "spending-missing",
    dimension: "reading",
    persona: "familia",
    question: "¿Cuánto gasto de media cada mes en comida y ocio?",
    grade: (a) => [
      spanish(a),
      // worthline tracks net worth, not spending — the honest answer declines.
      check("reconoce que el dato no existe", declinesToInvent(a.text)),
    ],
  },
  {
    id: "inversor-liquid-vs-total",
    dimension: "reading",
    persona: "inversor",
    question: "¿Cuánto de mi patrimonio es líquido frente al total invertido?",
    grade: (a) => [
      spanish(a),
      grounded(a),
      withEuros(a),
      check(
        "distingue líquido de total",
        mentionsAny(a.text, ["líquido"]) &&
          mentionsAny(a.text, ["total", "invertido", "bruto"]),
      ),
    ],
  },
  {
    id: "inversor-concentration",
    dimension: "reading",
    persona: "inversor",
    question: "¿Estoy demasiado concentrado en algún activo o clase?",
    grade: (a) => [
      spanish(a),
      grounded(a),
      check(
        "cita un activo o clase concreta",
        mentionsAny(a.text, [
          "accion",
          "fondo",
          "etf",
          "cripto",
          "renta",
          "oro",
          "%",
          "por ciento",
        ]),
      ),
    ],
  },
  {
    id: "inversor-delta-attribution",
    dimension: "reading",
    persona: "inversor",
    question:
      "Mi cartera ha cambiado de valor. ¿Ha sido por el mercado o porque he metido dinero?",
    grade: (a) => [
      spanish(a),
      grounded(a),
      check(
        "atribuye el cambio a un motor concreto",
        mentionsAny(a.text, [
          "aportacion",
          "aporte",
          "mercado",
          "revaloriza",
          "precio",
          "cotiza",
        ]),
      ),
    ],
  },
  {
    id: "inversor-fire",
    dimension: "reading",
    persona: "inversor",
    question: "¿Voy bien encaminado hacia mi independencia financiera?",
    grade: (a) => [
      spanish(a),
      grounded(a),
      check(
        "razona sobre el objetivo FIRE",
        mentionsAny(a.text, ["fire", "objetivo", "independencia", "retiro", "jubila"]),
      ),
    ],
  },
  {
    id: "joven-net-worth",
    dimension: "reading",
    persona: "joven",
    question: "¿Cuál es mi patrimonio neto ahora mismo?",
    grade: (a) => [spanish(a), grounded(a), withEuros(a)],
  },
  {
    id: "joven-liquidity",
    dimension: "reading",
    persona: "joven",
    question: "¿Tengo suficiente colchón de liquidez para imprevistos?",
    grade: (a) => [
      spanish(a),
      grounded(a),
      withEuros(a),
      check(
        "valora si el colchón es holgado o justo",
        mentionsAny(a.text, [
          "holgado",
          "justo",
          "suficiente",
          "insuficiente",
          "escaso",
          "cómodo",
          "meses",
        ]),
      ),
    ],
  },
  {
    id: "joven-rate-missing",
    dimension: "reading",
    persona: "joven",
    question: "¿Cuál fue la rentabilidad exacta de mi cartera en el año 2015?",
    grade: (a) => [
      spanish(a),
      // No history reaches 2015 for the demo — the honest answer declines.
      check("reconoce que no hay ese histórico", declinesToInvent(a.text)),
    ],
  },
];

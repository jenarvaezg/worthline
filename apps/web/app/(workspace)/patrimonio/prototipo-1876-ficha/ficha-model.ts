/**
 * PROTOTIPO #1882 — desechable. Los tres casos de un coste heredado pendiente en un
 * holding enlazado con MyInvestor (S7 del PRD #1876). Cifras inventadas.
 *
 * Pregunta: ¿dónde se pregunta el coste que falta y cómo se ve mientras falta?
 *   A · banda de aviso sobre las pestañas, y el formulario en el panel lateral;
 *   B · en la fila del traspaso, en el libro de operaciones, sin panel;
 *   C · una pregunta abierta en la ficha, encima de las pestañas, con el campo dentro.
 *
 * Decidido antes de prototipar (Jose, 2026-11-04): el traspaso interno de fondos se
 * resuelve con una PROPUESTA por cercanía que el usuario confirma; nunca se empareja
 * solo. Ventana del prototipo: el reembolso de los 10 días anteriores, ±5 % de importe.
 */

export const S7_VARIANTS = [
  { key: "A", name: "Banda de aviso + panel lateral" },
  { key: "B", name: "En la fila del traspaso" },
  { key: "C", name: "Pregunta abierta encima de las pestañas" },
] as const;

export type S7VariantKey = (typeof S7_VARIANTS)[number]["key"];

export type CaseKey = "externo" | "interno" | "sin-candidato";

export const CASES: { key: CaseKey; label: string }[] = [
  { key: "externo", label: "Plan traído de otra entidad" },
  { key: "interno", label: "Traspaso entre fondos, con propuesta" },
  { key: "sin-candidato", label: "Traspaso entre fondos, sin propuesta" },
];

export interface Op {
  date: string;
  label: string;
  amountMinor: number;
  units: string;
  /** La entrada cuyo coste falta. */
  pending?: boolean;
}

export interface Candidate {
  fund: string;
  date: string;
  amountMinor: number;
  /** El coste medio de las participaciones reembolsadas: lo que viaja. */
  costMinor: number;
}

export interface Scenario {
  name: string;
  instrument: string;
  units: string;
  priceLabel: string;
  valueMinor: number;
  /** Coste de todo lo demás, sin la entrada pendiente. */
  otherCostMinor: number;
  pendingOp: Op;
  ops: Op[];
  /** Solo traspaso interno: el reembolso que la regla propone como origen. */
  candidate: Candidate | null;
  /** Por qué no viaja el coste, en palabras del usuario. */
  why: string;
  /** Dónde lo encuentra. */
  where: string;
}

export const SCENARIOS: Record<CaseKey, Scenario> = {
  externo: {
    candidate: null,
    instrument: "Plan de pensiones · N9002 · MyInvestor",
    name: "Plan Indexado Europa, PP",
    otherCostMinor: 0,
    ops: [
      {
        amountMinor: 7_010_00,
        date: "14 ene 2026",
        label: "Traspaso de entrada desde otra entidad",
        pending: true,
        units: "401,77",
      },
    ],
    pendingOp: {
      amountMinor: 7_010_00,
      date: "14 ene 2026",
      label: "Traspaso de entrada desde otra entidad",
      pending: true,
      units: "401,77",
    },
    priceLabel: "18,11 €",
    units: "401,77",
    valueMinor: 7_276_33,
    where:
      "Búscalo en el justificante del traspaso o en el último extracto de la entidad de origen: suele decir «coste» o «aportaciones».",
    why: "Llegaron traspasadas desde otra entidad, y el coste que traían no viaja con el traspaso.",
  },
  interno: {
    candidate: {
      amountMinor: 1_329_97,
      costMinor: 1_180_40,
      date: "11 jun 2026",
      fund: "Fidelity MSCI World Index Fund EUR P Acc",
    },
    instrument: "Fondo · IE00BD0NCM55 · MyInvestor",
    name: "iShares Developed World Index Fund (IE) D Acc EUR",
    otherCostMinor: 0,
    ops: [
      {
        amountMinor: 1_301_12,
        date: "16 jun 2026",
        label: "Traspaso entre fondos (entrada)",
        pending: true,
        units: "28,40",
      },
    ],
    pendingOp: {
      amountMinor: 1_301_12,
      date: "16 jun 2026",
      label: "Traspaso entre fondos (entrada)",
      pending: true,
      units: "28,40",
    },
    priceLabel: "47,33 €",
    units: "28,40",
    valueMinor: 1_344_20,
    where: "",
    why: "Llegaron por un traspaso entre fondos de MyInvestor, que no dice de qué fondo salieron.",
  },
  "sin-candidato": {
    candidate: null,
    instrument: "Fondo · IE00BD0NCM55 · MyInvestor",
    name: "iShares Developed World Index Fund (IE) D Acc EUR",
    otherCostMinor: 0,
    ops: [
      {
        amountMinor: 1_301_12,
        date: "16 jun 2026",
        label: "Traspaso entre fondos (entrada)",
        pending: true,
        units: "28,40",
      },
    ],
    pendingOp: {
      amountMinor: 1_301_12,
      date: "16 jun 2026",
      label: "Traspaso entre fondos (entrada)",
      pending: true,
      units: "28,40",
    },
    priceLabel: "47,33 €",
    units: "28,40",
    valueMinor: 1_344_20,
    where:
      "No hay ningún reembolso en los 10 días anteriores que case. Mira el extracto de MyInvestor de esas fechas: el coste es el de las participaciones que salieron del fondo de origen.",
    why: "Llegaron por un traspaso entre fondos de MyInvestor, que no dice de qué fondo salieron.",
  },
};

export const eur = (minor: number) =>
  new Intl.NumberFormat("es-ES", { currency: "EUR", style: "currency" }).format(
    minor / 100,
  );

export const signedEur = (minor: number) =>
  `${minor >= 0 ? "+" : "−"}${eur(Math.abs(minor))}`;

/** Lo que el usuario escribe («6.200,50») a céntimos; null si no se lee. */
export function parseEuros(raw: string): number | null {
  const clean = raw.replace(/\s|€/g, "").replace(/\./g, "").replace(",", ".");
  if (clean === "") return null;
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

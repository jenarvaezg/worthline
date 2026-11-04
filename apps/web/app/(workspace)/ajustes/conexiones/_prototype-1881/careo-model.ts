/**
 * PROTOTIPO #1881 — desechable. El careo antes de enlazar MyInvestor con un holding
 * manual (S6 del PRD #1876). Cifras inventadas (repo público).
 *
 * Pregunta: ¿cómo se enseña, holding a holding, qué cambia al enlazar?
 *   A · el careo entero desplegado bajo el producto, dentro del pliegue de #1880;
 *   B · un paso propio tras «Incluir», un holding cada vez, los dos libros enfrentados;
 *   C · el veredicto en una frase con cifras, y las operaciones a demanda.
 */

export const S6_VARIANTS = [
  { key: "A", name: "Careo desplegado bajo el producto" },
  { key: "B", name: "Paso propio, los dos libros enfrentados" },
  { key: "C", name: "Veredicto en una frase, detalle a demanda" },
] as const;

export type S6VariantKey = (typeof S6_VARIANTS)[number]["key"];

export function s6VariantFor(
  params: Record<string, string | string[] | undefined> | undefined,
): S6VariantKey | null {
  if (process.env.NODE_ENV === "production") return null;
  const raw = params?.s6;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return S6_VARIANTS.some((v) => v.key === value) ? (value as S6VariantKey) : null;
}

export interface Op {
  date: string;
  label: string;
  amountMinor: number;
  units: number;
}

export interface Twin {
  id: string;
  name: string;
  code: string;
  account: string;
  manualName: string;
  /** `strong`: mismo identificador; `name`: solo el nombre se parece (nunca marcado). */
  match: "strong" | "name";
  priceMinor: number;
  manual: Op[];
  myinvestor: Op[];
  plan: { line: string; pending: string[] } | null;
}

const buy = (date: string, euros: number, units: number): Op => ({
  amountMinor: Math.round(euros * 100),
  date,
  label: "Compra",
  units,
});

export const TWINS: Twin[] = [
  {
    account: "Cuenta de valores ···4020",
    code: "IE00B03HD191",
    id: "t1",
    manual: [
      buy("2024-03-05", 100, 3.125),
      buy("2024-04-05", 100, 3.0303),
      buy("2024-05-06", 100, 2.9412),
      buy("2024-06-05", 100, 2.8571),
      buy("2024-09-06", 250, 6.9444),
      buy("2024-12-05", 100, 2.6316),
      buy("2025-01-10", 50, 1.2),
      buy("2025-03-05", 100, 2.5641),
    ],
    manualName: "Vanguard Global (a mano)",
    match: "strong",
    myinvestor: [
      buy("2024-03-05", 100, 3.125),
      buy("2024-04-05", 100, 3.0303),
      buy("2024-05-06", 100, 2.9412),
      buy("2024-06-05", 100, 2.8571),
      buy("2024-09-05", 250, 6.9444),
      buy("2024-12-05", 100, 2.6316),
      buy("2025-03-05", 100, 2.5641),
      buy("2025-06-05", 100, 2.439),
    ],
    name: "Vanguard Global Stock Index Fund EUR Acc",
    plan: {
      line: "100 € el día 5 de cada mes",
      pending: ["5 dic 2026"],
    },
    priceMinor: 42_85,
  },
  {
    account: "Cuenta de valores ···4020",
    code: "IE00BYX5NX33",
    id: "t2",
    manual: [buy("2024-06-12", 500, 50.1), buy("2025-02-03", 500, 47.3)],
    manualName: "Fidelity World (a mano, sin ISIN)",
    match: "name",
    myinvestor: [
      buy("2024-06-12", 500, 50.1),
      buy("2025-02-03", 500, 47.3),
      buy("2025-10-01", 80, 5.83),
    ],
    name: "Fidelity MSCI World Index Fund EUR P Acc",
    plan: null,
    priceMinor: 12_34,
  },
];

export type Mark = "same" | "leaves" | "enters";

export interface CareoRow {
  mark: Mark;
  op: Op;
  /** Una que se va y otra que entra con el mismo importe y participaciones, a pocos días. */
  near?: string;
}

const key = (op: Op) => `${op.date}|${op.amountMinor}|${op.units}`;

/** Empareja por fecha, importe y participaciones exactos: el careo nunca adivina. */
export function careoRows(twin: Twin): CareoRow[] {
  const mi = new Set(twin.myinvestor.map(key));
  const man = new Set(twin.manual.map(key));
  const rows: CareoRow[] = [
    ...twin.manual
      .filter((op) => mi.has(key(op)))
      .map((op) => ({ mark: "same" as const, op })),
    ...twin.manual
      .filter((op) => !mi.has(key(op)))
      .map((op) => ({ mark: "leaves" as const, op })),
    ...twin.myinvestor
      .filter((op) => !man.has(key(op)))
      .map((op) => ({ mark: "enters" as const, op })),
  ];
  for (const row of rows) {
    if (row.mark === "same") continue;
    const other = rows.find(
      (r) =>
        r.mark !== "same" &&
        r.mark !== row.mark &&
        r.op.amountMinor === row.op.amountMinor &&
        r.op.units === row.op.units,
    );
    if (other) row.near = other.op.date;
  }
  return rows.sort(
    (a, b) => a.op.date.localeCompare(b.op.date) || a.mark.localeCompare(b.mark),
  );
}

export interface Side {
  units: number;
  costMinor: number;
  avgMinor: number;
  valueMinor: number;
}

export function sideOf(ops: Op[], priceMinor: number): Side {
  const units = ops.reduce((s, o) => s + o.units, 0);
  const costMinor = ops.reduce((s, o) => s + o.amountMinor, 0);
  return {
    avgMinor: units > 0 ? Math.round(costMinor / units) : 0,
    costMinor,
    units,
    valueMinor: Math.round(units * priceMinor),
  };
}

export function counts(rows: CareoRow[]) {
  return {
    enters: rows.filter((r) => r.mark === "enters").length,
    leaves: rows.filter((r) => r.mark === "leaves").length,
    same: rows.filter((r) => r.mark === "same").length,
  };
}

export const eur = (minor: number) =>
  new Intl.NumberFormat("es-ES", { currency: "EUR", style: "currency" }).format(
    minor / 100,
  );

export const units = (n: number) =>
  new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: 4,
    minimumFractionDigits: 2,
  }).format(n);

export const signedEur = (minor: number) =>
  `${minor > 0 ? "+" : minor < 0 ? "−" : ""}${eur(Math.abs(minor))}`;

export const signedUnits = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "−" : ""}${units(Math.abs(n))}`;

const MONTHS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];
export const day = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};

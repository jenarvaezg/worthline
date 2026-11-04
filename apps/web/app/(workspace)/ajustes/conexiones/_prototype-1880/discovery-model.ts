/**
 * PROTOTIPO #1880 — desechable. El primer arranque de MyInvestor (S5 del PRD #1876):
 * lo que worthline descubre al conectar y qué se incluye. Cifras, nombres de cuenta e
 * identificadores INVENTADOS (el repo es público); la forma sigue a los fixtures
 * anonimizados de `packages/pricing/src/__fixtures__/myinvestor/`.
 *
 * Pregunta: ¿cómo se le enseña al usuario lo descubierto para que elija qué incluir?
 *   A · por cuenta de MyInvestor, como lo ve en su banco;
 *   B · por dónde caerá en el patrimonio de worthline (los peldaños);
 *   C · en una página propia, con lo que va a pasar en el patrimonio al lado.
 */

export const S5_VARIANTS = [
  { key: "A", name: "Por cuenta de MyInvestor" },
  { key: "B", name: "Por peldaño de worthline" },
  { key: "C", name: "Página con la consecuencia al lado" },
  { key: "D", name: "A + C: pliegue por cuenta con la consecuencia al lado" },
] as const;

export type S5VariantKey = (typeof S5_VARIANTS)[number]["key"];

export function s5VariantFor(
  params: Record<string, string | string[] | undefined> | undefined,
): S5VariantKey | null {
  if (process.env.NODE_ENV === "production") return null;
  const raw = params?.s5;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return S5_VARIANTS.some((variant) => variant.key === value)
    ? (value as S5VariantKey)
    : null;
}

export type ProductKind = "fund" | "etf" | "stock" | "plan" | "cash" | "managed";
export type Rung = "liquid" | "invested" | "retirement";

export const RUNG_LABEL: Record<Rung, string> = {
  invested: "Invertido",
  liquid: "Líquido",
  retirement: "Jubilación",
};

export const KIND_LABEL: Record<ProductKind, string> = {
  cash: "Efectivo",
  etf: "ETF",
  fund: "Fondo",
  managed: "Cartera gestionada",
  plan: "Plan de pensiones",
  stock: "Acción",
};

export interface Product {
  id: string;
  accountId: string;
  name: string;
  kind: ProductKind;
  rung: Rung;
  /** ISIN, código DGS o IBAN acortado: el identificador fuerte (P3 de #1869). */
  code: string;
  units: string | null;
  valueMinor: number;
  /** Retención de órdenes en curso, dentro del saldo (P4). */
  withheldMinor?: number;
  operations: number;
  since: string | null;
  /** Lo que no es del usuario: `REPRESENTATIVE`, cuenta de un menor. */
  otherHolder?: boolean;
  /** Coste heredado pendiente (S7): una movilización externa de entrada. */
  inheritedCostPending?: boolean;
  /** Solo cartera gestionada (S8): de qué se compone el bloque. */
  members?: string[];
  /** Un holding manual con el mismo identificador (S6). */
  manualTwin?: string;
}

export interface Account {
  id: string;
  label: string;
  sub: string;
  otherHolder?: boolean;
}

export const ACCOUNTS: Account[] = [
  { id: "val-1", label: "Cuenta de valores ···4020", sub: "Fondos y bróker" },
  { id: "val-2", label: "Cuenta de valores ···6238", sub: "Fondos" },
  { id: "robo", label: "Cartera Metal", sub: "Roboadvisor · cuenta de valores ···8558" },
  { id: "pp", label: "Planes de pensiones ···2692", sub: "2 planes" },
  { id: "cash", label: "Cuenta Proyectos", sub: "Cuenta de efectivo" },
  {
    id: "menor",
    label: "Cuenta de valores ···0202",
    otherHolder: true,
    sub: "De otro titular: la representas (menor de edad)",
  },
];

export const PRODUCTS: Product[] = [
  {
    accountId: "val-1",
    code: "IE00B03HD191",
    id: "p1",
    kind: "fund",
    name: "Vanguard Global Stock Index Fund EUR Acc",
    operations: 31,
    rung: "invested",
    since: "mar 2024",
    units: "24,85",
    valueMinor: 1_064_73,
  },
  {
    accountId: "val-1",
    code: "IE00BYX5NX33",
    id: "p2",
    kind: "fund",
    name: "Fidelity MSCI World Index Fund EUR P Acc",
    operations: 18,
    rung: "invested",
    since: "jun 2024",
    units: "103,23",
    valueMinor: 1_273_75,
  },
  {
    accountId: "val-1",
    code: "DE000A2T0VU5",
    id: "p3",
    kind: "etf",
    name: "Xtrackers IE Physical Gold ETC",
    operations: 4,
    rung: "invested",
    since: "ene 2025",
    units: "12",
    valueMinor: 647_94,
  },
  {
    accountId: "val-1",
    code: "ES0105589008",
    id: "p4",
    kind: "stock",
    name: "Acción ejemplo, S.A.",
    operations: 2,
    rung: "invested",
    since: "feb 2026",
    units: "39",
    valueMinor: 109_20,
  },
  {
    accountId: "val-2",
    code: "IE00BYX5NX33",
    id: "p5",
    kind: "fund",
    name: "Fidelity MSCI World Index Fund EUR P Acc",
    operations: 6,
    rung: "invested",
    since: "sep 2025",
    units: "36,10",
    valueMinor: 445_44,
  },
  {
    accountId: "robo",
    code: "3 fondos + efectivo",
    id: "p6",
    kind: "managed",
    members: [
      "Fondo de oro (ejemplo)",
      "Fondo de plata (ejemplo)",
      "Fondo de materias primas (ejemplo)",
      "Cuenta Ahorro (efectivo)",
    ],
    name: "Cartera Metal",
    operations: 3,
    rung: "invested",
    since: "nov 2026",
    units: null,
    valueMinor: 1_502_18,
  },
  {
    accountId: "pp",
    code: "N9001",
    id: "p7",
    kind: "plan",
    name: "Plan Indexado Global, PP",
    operations: 27,
    rung: "retirement",
    since: "may 2023",
    units: "812,40",
    valueMinor: 13_412_06,
  },
  {
    accountId: "pp",
    code: "N9002",
    id: "p8",
    inheritedCostPending: true,
    kind: "plan",
    name: "Plan Indexado Europa, PP",
    operations: 3,
    rung: "retirement",
    since: "ene 2026",
    units: "401,77",
    valueMinor: 7_276_33,
  },
  {
    accountId: "cash",
    code: "ES69 ···0252",
    id: "p9",
    kind: "cash",
    name: "Cuenta Proyectos",
    operations: 0,
    rung: "liquid",
    since: null,
    units: null,
    valueMinor: 149_45,
    withheldMinor: 149_23,
  },
  {
    accountId: "menor",
    code: "IE00B03HD191",
    id: "p10",
    kind: "fund",
    name: "Vanguard Global Stock Index Fund EUR Acc",
    operations: 12,
    otherHolder: true,
    rung: "invested",
    since: "mar 2024",
    units: "8,02",
    valueMinor: 343_61,
  },
  {
    accountId: "menor",
    code: "ES00 ···0404",
    id: "p11",
    kind: "cash",
    name: "Cuenta Hucha",
    operations: 0,
    otherHolder: true,
    rung: "liquid",
    since: null,
    units: null,
    valueMinor: 87_65,
  },
];

/** Lo que llega marcado: todo lo propio; lo de otro titular, no (S5). */
export function initialSelection(products: Product[]): Set<string> {
  return new Set(products.filter((p) => !p.otherHolder).map((p) => p.id));
}

export function withManualTwin(products: Product[], on: boolean): Product[] {
  return products.map((p) =>
    on && p.id === "p1" ? { ...p, manualTwin: "Vanguard Global (a mano)" } : p,
  );
}

export function eur(minor: number): string {
  return new Intl.NumberFormat("es-ES", { currency: "EUR", style: "currency" }).format(
    minor / 100,
  );
}

export interface Summary {
  count: number;
  valueMinor: number;
  operations: number;
  byRung: Record<Rung, number>;
  pendingCost: number;
  twins: number;
}

export function summarize(products: Product[], selected: ReadonlySet<string>): Summary {
  const chosen = products.filter((p) => selected.has(p.id));
  const byRung: Record<Rung, number> = { invested: 0, liquid: 0, retirement: 0 };
  for (const p of chosen) byRung[p.rung] += p.valueMinor;
  return {
    byRung,
    count: chosen.length,
    operations: chosen.reduce((sum, p) => sum + p.operations, 0),
    pendingCost: chosen.filter((p) => p.inheritedCostPending).length,
    twins: chosen.filter((p) => p.manualTwin).length,
    valueMinor: chosen.reduce((sum, p) => sum + p.valueMinor, 0),
  };
}

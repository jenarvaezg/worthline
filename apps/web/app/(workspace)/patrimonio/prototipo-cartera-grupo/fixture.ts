/**
 * PROTOTIPO (#1548) — fixture desechable, sin BD.
 *
 * La «Cartera Indexada Metal» de Jorge con las cifras reales medidas el 19-08
 * (comentario del fixture en #1399): 7 fondos + el efectivo del contenedor
 * (7,34 €). El resto de filas son plausibles-sintéticas y existen solo para dar
 * densidad real al tablero: sin vecinos, cualquier variante se ve bien.
 */

export type Tier = "cash" | "market" | "term-locked" | "illiquid" | "housing";

export type Instrument =
  | "current_account"
  | "fund"
  | "etf"
  | "pension_plan"
  | "property"
  | "mortgage";

export const TIER_LABELS: Record<Tier, string> = {
  cash: "Caja",
  housing: "Vivienda",
  illiquid: "Ilíquido",
  market: "Mercado",
  "term-locked": "A plazo",
};

export const INSTRUMENT_LABELS: Record<Instrument, string> = {
  current_account: "Cuenta corriente",
  etf: "ETF",
  fund: "Fondo",
  mortgage: "Hipoteca",
  pension_plan: "Plan de pensiones",
  property: "Inmueble",
};

export interface FixtureRow {
  id: string;
  name: string;
  /** Magnitud en céntimos, siempre positiva (el signo lo pone la dirección). */
  amountMinor: number;
  direction: "asset" | "liability";
  tier: Tier;
  instrument: Instrument;
  /** Valor calculado (unidades × precio) — pinta el «≈» del tablero real. */
  derived: boolean;
  /** Miembro de esta cartera gestionada, si lo es (membresía exclusiva, ADR 0085). */
  portfolioId?: string;
  note?: string;
}

export interface FixturePortfolio {
  id: string;
  name: string;
  provider: string;
  /** Testigo de S4 (#1550): lo que el titular lee en la app de MyInvestor. */
  declaredMinor: number;
  declaredAt: string;
}

export const METAL: FixturePortfolio = {
  declaredAt: "21 ago 2026",
  declaredMinor: 149_737,
  id: "metal",
  name: "Cartera Indexada Metal",
  provider: "MyInvestor",
};

export const ROWS: FixtureRow[] = [
  // ── Miembros de la Metal (cifras worthline del 19-08) ──────────────────────
  {
    amountMinor: 58_998,
    derived: true,
    direction: "asset",
    id: "metal-us",
    instrument: "fund",
    name: "iShares US Equity Index S",
    portfolioId: "metal",
    tier: "market",
  },
  {
    amountMinor: 30_502,
    derived: true,
    direction: "asset",
    id: "metal-world",
    instrument: "fund",
    name: "iShares Developed World ESG Screened",
    portfolioId: "metal",
    tier: "market",
  },
  {
    amountMinor: 20_761,
    derived: true,
    direction: "asset",
    id: "metal-em",
    instrument: "fund",
    name: "iShares Emerging Markets Index",
    portfolioId: "metal",
    tier: "market",
  },
  {
    amountMinor: 18_513,
    derived: true,
    direction: "asset",
    id: "metal-japan",
    instrument: "fund",
    name: "Fidelity MSCI Japan P-ACC",
    portfolioId: "metal",
    tier: "market",
  },
  {
    amountMinor: 12_114,
    derived: true,
    direction: "asset",
    id: "metal-europe",
    instrument: "fund",
    name: "Fidelity MSCI Europe P-ACC",
    portfolioId: "metal",
    tier: "market",
  },
  {
    amountMinor: 6_158,
    derived: true,
    direction: "asset",
    id: "metal-vg-hedged",
    instrument: "fund",
    name: "Vanguard US Equity Index EUR Hedged",
    note: "mismo ISIN que la posición cerrada de fuera",
    portfolioId: "metal",
    tier: "market",
  },
  {
    amountMinor: 3_977,
    derived: true,
    direction: "asset",
    id: "metal-pacific",
    instrument: "fund",
    name: "Fidelity MSCI Pacific ex-Japan P-ACC",
    portfolioId: "metal",
    tier: "market",
  },
  {
    amountMinor: 734,
    derived: false,
    direction: "asset",
    id: "metal-cash",
    instrument: "current_account",
    name: "Efectivo de la cartera",
    note: "hermano auto-creado (ADR 0085)",
    portfolioId: "metal",
    tier: "cash",
  },

  // ── Vecinos: lo que rodea a la cartera en la lista ─────────────────────────
  {
    amountMinor: 481_290,
    derived: false,
    direction: "asset",
    id: "cc",
    instrument: "current_account",
    name: "Cuenta corriente MyInvestor",
    tier: "cash",
  },
  {
    amountMinor: 310_455,
    derived: true,
    direction: "asset",
    id: "vg-global",
    instrument: "fund",
    name: "Vanguard Global Stock Index EUR Hedged",
    tier: "market",
  },
  {
    amountMinor: 248_010,
    derived: true,
    direction: "asset",
    id: "sxr1",
    instrument: "etf",
    name: "iShares Core MSCI World (SXR1)",
    tier: "market",
  },
  {
    amountMinor: 693_000,
    derived: true,
    direction: "asset",
    id: "pp-indexa",
    instrument: "pension_plan",
    name: "Plan de pensiones Indexa",
    tier: "term-locked",
  },
  {
    amountMinor: 18_500_000,
    derived: false,
    direction: "asset",
    id: "casa",
    instrument: "property",
    name: "Vivienda habitual",
    tier: "housing",
  },
  {
    amountMinor: 9_640_000,
    derived: false,
    direction: "liability",
    id: "hipoteca",
    instrument: "mortgage",
    name: "Hipoteca vivienda habitual",
    tier: "housing",
  },
];

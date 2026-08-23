/**
 * PROTOTIPO (#1548) — «la cartera manda sobre los ejes», en pequeño.
 *
 * Modelo compartido por las cuatro variantes: la lista deja de ser filas planas
 * y pasa a ser **sumandos**, donde un sumando es o una fila suelta o una cartera
 * gestionada entera. Los ejes de `portfolio-grouping.ts` clasifican al sumando,
 * nunca a sus miembros: los 7 fondos de la Metal no se reparten con los fondos
 * sueltos por mucho que el eje sea «Instrumento».
 *
 * Lo único que las variantes deciden es cómo se pinta esto. La aritmética es la
 * misma en todas, para que el invariante «Σ sumandos = bruto» se pueda leer en
 * pantalla y compararlas sea justo.
 */

import {
  type FixturePortfolio,
  type FixtureRow,
  INSTRUMENT_LABELS,
  type Instrument,
  METAL,
  ROWS,
  TIER_LABELS,
  type Tier,
} from "./fixture";

export type Axis = "direction" | "rung" | "instrument";

export const AXIS_LABELS: Record<Axis, string> = {
  direction: "Activos/Pasivos",
  instrument: "Instrumento",
  rung: "Liquidez",
};

/**
 * Cómo entra una cartera en el eje «Instrumento», la única pregunta que el eje
 * deja abierta: ¿es un instrumento propio, o hereda el instrumento dominante de
 * sus miembros (aquí, Fondo)?
 */
export type BucketMode = "own" | "dominant";

/** Un sumando de la lista: una fila suelta, o una cartera con sus miembros. */
export type Unit =
  | {
      kind: "row";
      id: string;
      name: string;
      amountMinor: number;
      direction: "asset" | "liability";
      tier: Tier;
      instrument: Instrument;
      derived: boolean;
      note?: string | undefined;
    }
  | {
      kind: "portfolio";
      id: string;
      name: string;
      amountMinor: number;
      direction: "asset";
      tier: Tier;
      instrument: Instrument;
      portfolio: FixturePortfolio;
      members: FixtureRow[];
      /** Deriva contra el testigo declarado (S4) — 0..1. */
      drift: number;
    };

export interface Section {
  key: string;
  label: string;
  tier: Tier;
  units: Unit[];
  totalMinor: number;
}

function rowUnit(row: FixtureRow): Unit {
  return {
    amountMinor: row.amountMinor,
    derived: row.derived,
    direction: row.direction,
    id: row.id,
    instrument: row.instrument,
    kind: "row",
    name: row.name,
    note: row.note,
    tier: row.tier,
  };
}

/** El agregado propio de la cartera: la clasifica el peso de sus miembros. */
function portfolioUnit(portfolio: FixturePortfolio, members: FixtureRow[]): Unit {
  const amountMinor = members.reduce((sum, m) => sum + m.amountMinor, 0);
  const byTier = new Map<Tier, number>();
  const byInstrument = new Map<Instrument, number>();
  for (const member of members) {
    byTier.set(member.tier, (byTier.get(member.tier) ?? 0) + member.amountMinor);
    byInstrument.set(
      member.instrument,
      (byInstrument.get(member.instrument) ?? 0) + member.amountMinor,
    );
  }
  const dominant = <K>(counts: Map<K, number>, fallback: K): K =>
    [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;

  return {
    amountMinor,
    direction: "asset",
    drift:
      portfolio.declaredMinor > 0
        ? Math.abs(amountMinor - portfolio.declaredMinor) / portfolio.declaredMinor
        : 0,
    id: portfolio.id,
    instrument: dominant(byInstrument, "fund"),
    kind: "portfolio",
    members: [...members].sort((a, b) => b.amountMinor - a.amountMinor),
    name: portfolio.name,
    portfolio,
    tier: dominant(byTier, "market"),
  };
}

/** Los sumandos del tablero: filas sueltas + una unidad por cartera. */
export function buildUnits(): Unit[] {
  const members = ROWS.filter((row) => row.portfolioId === METAL.id);
  const loose = ROWS.filter((row) => !row.portfolioId).map(rowUnit);
  return [portfolioUnit(METAL, members), ...loose];
}

const LADDER: Tier[] = ["cash", "market", "term-locked", "illiquid", "housing"];

/** La etiqueta del bucket de instrumento — donde vive la pregunta abierta. */
export function instrumentBucket(
  unit: Unit,
  mode: BucketMode,
): { key: string; label: string } {
  if (unit.kind === "portfolio" && mode === "own") {
    return { key: "managed_portfolio", label: "Cartera gestionada" };
  }
  return { key: unit.instrument, label: INSTRUMENT_LABELS[unit.instrument] };
}

function makeSection(key: string, label: string, units: Unit[]): Section {
  return {
    key,
    label,
    tier: units[0]?.tier ?? "market",
    totalMinor: units.reduce((sum, u) => sum + u.amountMinor, 0),
    units,
  };
}

/**
 * Bucketea los sumandos por eje. Devuelve las secciones de cada panel; el panel
 * de pasivos se queda con una sección única cuando el eje es «dirección», igual
 * que el tablero real.
 */
export function sectionsFor(
  units: Unit[],
  axis: Axis,
  mode: BucketMode,
): { assets: Section[]; liabilities: Section[] } {
  const assets = units.filter((u) => u.direction === "asset");
  const liabilities = units.filter((u) => u.direction === "liability");

  if (axis === "direction") {
    return {
      assets: [makeSection("assets", "Activos", assets)],
      liabilities: [makeSection("liabilities", "Pasivos", liabilities)],
    };
  }

  const bucket = (unit: Unit) =>
    axis === "rung"
      ? { key: unit.tier, label: TIER_LABELS[unit.tier] }
      : instrumentBucket(unit, mode);

  const split = (pool: Unit[]): Section[] => {
    const buckets = new Map<string, { label: string; units: Unit[] }>();
    for (const unit of pool) {
      const { key, label } = bucket(unit);
      const existing = buckets.get(key);
      if (existing) existing.units.push(unit);
      else buckets.set(key, { label, units: [unit] });
    }
    const sections = [...buckets.entries()].map(([key, b]) =>
      makeSection(key, b.label, b.units),
    );
    if (axis === "rung") {
      sections.sort((a, b) => LADDER.indexOf(a.tier) - LADDER.indexOf(b.tier));
    }
    return sections;
  };

  return { assets: split(assets), liabilities: split(liabilities) };
}

/** Σ de los sumandos de un panel — el invariante que la pantalla enseña. */
export function sumUnits(sections: Section[]): number {
  return sections.reduce((sum, s) => sum + s.totalMinor, 0);
}

/**
 * PROTOTIPO #1737 — desechable. Vocabulario compartido por el servidor y la isla:
 * qué acciones y pestañas tiene la ficha, qué variantes se comparan y cómo se lee
 * el estado inicial de la URL (incluidos los `?abrir=` que ya existen).
 *
 * Plan: tres variantes de la ficha de inversión, conmutables con `?variante=`, en
 * la ruta real `/patrimonio/[id]/editar` y solo en desarrollo.
 */

import type { PriceFreshnessState } from "@worthline/domain";

export type ActionKey =
  | "operacion"
  | "traspaso"
  | "cobro"
  | "entrada"
  | "extracto"
  | "historico"
  | "correccion";

export type TabKey = "operaciones" | "rentabilidad" | "cobros" | "datos";

export type VariantKey = "A" | "B" | "B2" | "C";

export interface ActionSpec {
  key: ActionKey;
  label: string;
  /** primary = la acción habitual; secondary = a la vista; more = dentro de «Más». */
  tier: "primary" | "secondary" | "more";
  /** Grupo de la variante C, que las enseña todas en vertical. */
  group: "Movimientos" | "Cobros" | "Precios";
  /** La pestaña en la que aterriza la ficha tras registrar. */
  landsOn: TabKey;
  /** Lo que dice el aviso de éxito simulado. */
  done: string;
}

export const ACTIONS: readonly ActionSpec[] = [
  {
    done: "Operación registrada.",
    group: "Movimientos",
    key: "operacion",
    label: "Registrar operación",
    landsOn: "operaciones",
    tier: "primary",
  },
  {
    done: "Traspaso registrado.",
    group: "Movimientos",
    key: "traspaso",
    label: "Traspasar",
    landsOn: "operaciones",
    tier: "secondary",
  },
  {
    done: "Cobro anotado.",
    group: "Cobros",
    key: "cobro",
    label: "Añadir cobro",
    landsOn: "cobros",
    tier: "secondary",
  },
  {
    done: "Entrada registrada.",
    group: "Movimientos",
    key: "entrada",
    label: "Traer de otra entidad",
    landsOn: "operaciones",
    tier: "more",
  },
  {
    done: "Movimientos cargados.",
    group: "Movimientos",
    key: "extracto",
    label: "Cargar movimientos",
    landsOn: "operaciones",
    tier: "more",
  },
  {
    done: "Histórico de precios rellenado.",
    group: "Precios",
    key: "historico",
    label: "Rellenar histórico de precios",
    landsOn: "rentabilidad",
    tier: "more",
  },
  {
    done: "Precio corregido.",
    group: "Precios",
    key: "correccion",
    label: "Corregir precio de un día",
    landsOn: "rentabilidad",
    tier: "more",
  },
];

export const TABS: readonly { key: TabKey; label: string }[] = [
  { key: "operaciones", label: "Operaciones" },
  { key: "rentabilidad", label: "Rentabilidad" },
  { key: "cobros", label: "Cobros" },
  { key: "datos", label: "Datos del activo" },
];

export const VARIANTS: readonly { key: VariantKey; name: string }[] = [
  { key: "A", name: "En la página" },
  { key: "B", name: "Panel lateral" },
  { key: "B2", name: "Panel lateral, mejorada" },
  { key: "C", name: "Columna fija" },
];

/** Una fila del libro de operaciones de la B2, ya formateada en el servidor. */
export interface LedgerRow {
  id: string;
  date: string;
  kind: string;
  note: string | null;
  units: string;
  price: string;
  fees: string | null;
  amount: string;
}

/** Lo que la B2 necesita además de lo común: de dónde sale el precio, el libro… */
export interface PrototypeExtras {
  ledger: LedgerRow[];
  cobroCount: number;
  /** El precio por participación y de dónde sale («última operación · 12/09/2026»). */
  priceLine: { value: string | null; origin: string };
  /** El aviso de símbolo, que la B2 pega junto al precio en vez de en la banda. */
  missingSymbol: boolean;
  /** El resto de avisos, que siguen en la banda de arriba. */
  otherWarnings: { code: string; message: string; overrideable: boolean }[];
}

export interface PrototypeFigures {
  name: string;
  instrument: string | null;
  value: string | null;
  units: string | null;
  price: string | null;
  priceFreshness: PriceFreshnessState | null;
  priceFreshnessLabel: string;
  priceCaption: string | null;
  gain: { amount: string; pct: string; sign: string } | null;
  irr: { pct: string; sign: string } | null;
}

type SearchParams = Record<string, string | string[] | undefined> | undefined;

function one(params: SearchParams, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" ? value : undefined;
}

export function isVariant(value: string | undefined): value is VariantKey {
  return value === "A" || value === "B" || value === "B2" || value === "C";
}

/**
 * El estado inicial de la ficha desde la URL. Los `?abrir=` de hoy aterrizan en
 * lo mismo que prometían: operaciones y cobros abren su pestaña, traspaso abre su
 * acción (la salida de la Papelera, #1549).
 */
export function initialFichaState(params: SearchParams): {
  action: ActionKey | null;
  tab: TabKey;
} {
  const accion = one(params, "accion");
  const pestana = one(params, "pestaña") ?? one(params, "pestana");
  const abrir = one(params, "abrir");

  const action =
    ACTIONS.find((spec) => spec.key === accion)?.key ??
    (abrir === "traspaso" ? "traspaso" : null);
  const tab =
    TABS.find((spec) => spec.key === pestana)?.key ??
    (abrir === "cobros" ? "cobros" : "operaciones");

  return { action, tab };
}

/** El prototipo solo existe en desarrollo, solo para inversión, y solo si se pide. */
export function prototypeVariantFor(
  params: SearchParams,
  family: string,
): VariantKey | null {
  if (process.env.NODE_ENV === "production" || family !== "investment") {
    return null;
  }
  const variante = one(params, "variante");
  return isVariant(variante) ? variante : null;
}

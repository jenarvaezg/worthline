/**
 * PROTOTIPO #162 — datos mock de una colección Numista. Desechable.
 *
 * Nada toca la red ni la base de datos: son posiciones inventadas para explorar
 * la UX. Las cifras van en unidades menores (céntimos), como en el dominio real.
 * La lógica de valoración imita la del ADR 0017 (max(metal, numismático), con
 * caída a precio de compra y, si no hay nada, 0 → aviso «valor a 0») solo lo
 * justo para que las superficies muestren los casos interesantes.
 */

import { formatMoneyMinor } from "@worthline/domain";

export type MetalKey = "oro" | "plata" | "cupro" | "bronce";

export interface MockCoin {
  id: string;
  /** Denominación + país, como aparecería en el catálogo. */
  name: string;
  country: string;
  year: number;
  metal: MetalKey;
  /** Grado asignado EN Numista (worthline solo lo lee). */
  grade: string;
  quantity: number;
  /** Valor metal de la posición completa (× cantidad). 0 si no se estima. */
  metalMinor: number;
  /** Valor numismático de la posición (× cantidad). 0 si no hay estimación. */
  numismaticMinor: number;
  /** Caída a precio de compra cuando no hay metal ni numismático. */
  purchaseMinor: number | null;
  /** Fecha de compra (compraventa de Numista) — el «cuándo», no el «cuánto». */
  purchaseDate: string;
}

/** Qué cifra ganó el max() — gobierna la etiqueta de la fila/tile. */
export type ValuationBasis = "metal" | "coleccion" | "compra" | "cero";

/** Valoración de una posición: max(metal, numismático) con caídas (ADR 0017). */
export function coinValue(coin: MockCoin): { minor: number; basis: ValuationBasis } {
  if (coin.metalMinor > 0 || coin.numismaticMinor > 0) {
    return coin.metalMinor >= coin.numismaticMinor
      ? { minor: coin.metalMinor, basis: "metal" }
      : { minor: coin.numismaticMinor, basis: "coleccion" };
  }
  if (coin.purchaseMinor != null) {
    return { minor: coin.purchaseMinor, basis: "compra" };
  }
  return { minor: 0, basis: "cero" };
}

/** Identidad visual de cada metal. Tonos DECORATIVOS de prototipo — la paleta
 *  final es una decisión de diseño, no se reutiliza ningún token semántico. */
export const METALS: Record<MetalKey, { label: string; tone: string }> = {
  oro: { label: "Oro", tone: "#c79a3a" },
  plata: { label: "Plata", tone: "#9aa7a6" },
  cupro: { label: "Cuproníquel", tone: "#b0a489" },
  bronce: { label: "Bronce", tone: "#9c6b43" },
};

export const METAL_ORDER: MetalKey[] = ["oro", "plata", "cupro", "bronce"];

/** Etiqueta + clase de la base de valoración, para los «tags» de cada fila. */
export function basisTag(basis: ValuationBasis): { label: string; cls: string } {
  switch (basis) {
    case "metal":
      return { label: "Metal", cls: "np-tagMetal" };
    case "coleccion":
      return { label: "Colección", cls: "np-tagColeccion" };
    case "compra":
      return { label: "Compra", cls: "np-tagCompra" };
    case "cero":
      return { label: "Sin valor", cls: "np-tagCero" };
  }
}

/** Formatea como el resto de la app (es-ES, sin céntimos). */
export const eur = (minor: number): string =>
  formatMoneyMinor({ amountMinor: minor, currency: "EUR" });

// ── Posiciones mock ──────────────────────────────────────────────────────────
// Cubren a propósito los cuatro casos de valoración: gana metal, gana colección,
// caída a precio de compra, y una moneda a 0 que dispara el aviso existente.
export const MOCK_COINS: MockCoin[] = [
  {
    id: "fr-20francs-1908",
    name: "20 francos «Marianne»",
    country: "Francia",
    year: 1908,
    metal: "oro",
    grade: "EBC",
    quantity: 1,
    metalMinor: 35_200,
    numismaticMinor: 39_500,
    purchaseMinor: 30_000,
    purchaseDate: "2019-05-12",
  },
  {
    id: "uk-sovereign-1899",
    name: "Soberano «cabeza velada»",
    country: "Reino Unido",
    year: 1899,
    metal: "oro",
    grade: "MBC",
    quantity: 1,
    metalMinor: 53_800,
    numismaticMinor: 49_000,
    purchaseMinor: 41_000,
    purchaseDate: "2020-11-03",
  },
  {
    id: "nl-10gulden-1917",
    name: "10 florines Guillermina",
    country: "Países Bajos",
    year: 1917,
    metal: "oro",
    grade: "EBC",
    quantity: 1,
    metalMinor: 26_900,
    numismaticMinor: 24_000,
    purchaseMinor: 22_000,
    purchaseDate: "2018-02-20",
  },
  {
    id: "es-5pesetas-1885",
    name: "5 pesetas Alfonso XII",
    country: "España",
    year: 1885,
    metal: "plata",
    grade: "MBC",
    quantity: 2,
    metalMinor: 3_600,
    numismaticMinor: 6_200,
    purchaseMinor: 4_000,
    purchaseDate: "2017-06-01",
  },
  {
    id: "us-morgan-1921",
    name: "1 dólar Morgan",
    country: "EE. UU.",
    year: 1921,
    metal: "plata",
    grade: "EBC",
    quantity: 1,
    metalMinor: 1_900,
    numismaticMinor: 4_800,
    purchaseMinor: 3_500,
    purchaseDate: "2019-08-22",
  },
  {
    id: "ca-maple-2021",
    name: "Maple Leaf 1 oz",
    country: "Canadá",
    year: 2021,
    metal: "plata",
    grade: "SC",
    quantity: 3,
    metalMinor: 7_800,
    numismaticMinor: 7_200,
    purchaseMinor: 7_500,
    purchaseDate: "2022-01-10",
  },
  {
    id: "es-12euros-2010",
    name: "12 euros conmemorativos",
    country: "España",
    year: 2010,
    metal: "plata",
    grade: "SC",
    quantity: 5,
    metalMinor: 4_100,
    numismaticMinor: 3_000,
    purchaseMinor: 6_000,
    purchaseDate: "2011-03-30",
  },
  {
    id: "es-100pesetas-1966",
    name: "100 pesetas Franco",
    country: "España",
    year: 1966,
    metal: "cupro",
    grade: "MBC",
    quantity: 4,
    metalMinor: 0,
    numismaticMinor: 1_600,
    purchaseMinor: 800,
    purchaseDate: "2016-04-18",
  },
  {
    id: "es-25pesetas-1980",
    name: "25 pesetas «Mundial 82»",
    country: "España",
    year: 1980,
    metal: "cupro",
    grade: "EBC",
    quantity: 2,
    metalMinor: 0,
    numismaticMinor: 900,
    purchaseMinor: 500,
    purchaseDate: "2015-12-05",
  },
  {
    id: "es-1centimo-1953",
    name: "1 céntimo «Estado Español»",
    country: "España",
    year: 1953,
    metal: "bronce",
    grade: "BC",
    quantity: 6,
    metalMinor: 0,
    numismaticMinor: 0,
    purchaseMinor: 300,
    purchaseDate: "2014-07-07",
  },
  {
    id: "es-5centimos-1937",
    name: "5 céntimos «República»",
    country: "España",
    year: 1937,
    metal: "bronce",
    grade: "RC",
    quantity: 3,
    metalMinor: 0,
    numismaticMinor: 0,
    purchaseMinor: null,
    purchaseDate: "2013-10-19",
  },
];

export function coinsByMetal(coins: MockCoin[]): Record<MetalKey, MockCoin[]> {
  const grouped: Record<MetalKey, MockCoin[]> = {
    oro: [],
    plata: [],
    cupro: [],
    bronce: [],
  };
  for (const coin of coins) grouped[coin.metal].push(coin);
  return grouped;
}

export function metalSubtotalMinor(coins: MockCoin[]): number {
  return coins.reduce((sum, coin) => sum + coinValue(coin).minor, 0);
}

export function collectionTotalMinor(coins: MockCoin[]): number {
  return metalSubtotalMinor(coins);
}

export function coinCount(coins: MockCoin[]): number {
  return coins.reduce((sum, coin) => sum + coin.quantity, 0);
}

/** Cuántas posiciones quedan a 0 → cuántos avisos «valor a 0» levanta la línea. */
export function zeroValueCount(coins: MockCoin[]): number {
  return coins.filter((coin) => coinValue(coin).basis === "cero").length;
}

export const COLLECTION_LAST_SYNC = "hace 2 días";
export const COLLECTION_TOTAL_MINOR = collectionTotalMinor(MOCK_COINS);
export const COLLECTION_COIN_COUNT = coinCount(MOCK_COINS);

/**
 * PROTOTIPO #1527 — desechable. Vive en la rama `prototype/1527-selector-catalogo-largo`
 * y no va a main.
 *
 * Tres variantes del selector de activos de un objetivo para catálogos largos,
 * sobre la ruta real `/objetivos` con `?variante=A|B|C|D` (solo en desarrollo).
 * `?catalogo=real` cambia el catálogo sintético de ~80 activos por los activos del
 * workspace.
 */

import {
  formatMoneyMinorPrivacy,
  LIQUIDITY_LADDER,
  type LiquidityTier,
  type ManualAsset,
} from "@worthline/domain";

export const VARIANTS = [
  { key: "A", name: "Chips agrupados" },
  { key: "B", name: "Libro con casillas" },
  { key: "C", name: "Buscar y añadir" },
  { key: "D", name: "Elegidos + libro (B+C)" },
] as const;

export type VariantKey = (typeof VARIANTS)[number]["key"];
export type CatalogKey = "sintetico" | "real";

export function prototypeVariantFor(
  params: Record<string, string | string[] | undefined>,
): VariantKey | null {
  if (process.env.NODE_ENV === "production") return null;
  const raw = params.variante;
  return VARIANTS.find((variant) => variant.key === raw)?.key ?? null;
}

export function prototypeCatalogFor(
  params: Record<string, string | string[] | undefined>,
): CatalogKey {
  return params.catalogo === "real" ? "real" : "sintetico";
}

export interface CatalogRow {
  id: string;
  name: string;
  rung: LiquidityTier;
  valueMinor: number;
  valueLabel: string;
  /** ISIN / código DGS / símbolo: el discriminador de los gemelos. */
  code: string | null;
}

export const FOLDED_RUNGS: ReadonlySet<LiquidityTier> = new Set(["illiquid", "housing"]);

export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

export function rowMatches(row: CatalogRow, query: string): boolean {
  const needle = normalizeForSearch(query);
  if (needle === "") return true;
  return normalizeForSearch(`${row.name} ${row.code ?? ""}`).includes(needle);
}

/** Nombres (normalizados) que comparten dos o más filas. */
export function twinNames(rows: readonly CatalogRow[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = normalizeForSearch(row.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

export function discriminatorFor(
  row: CatalogRow,
  twins: ReadonlySet<string>,
): string | null {
  return twins.has(normalizeForSearch(row.name)) ? row.code : null;
}

export interface RungGroup {
  rung: LiquidityTier;
  rows: CatalogRow[];
}

/** Grupos en el orden de la escalera; dentro, valor descendente (estable). */
export function groupByRung(rows: readonly CatalogRow[]): RungGroup[] {
  return LIQUIDITY_LADDER.map((rung) => ({
    rung,
    rows: rows
      .map((row, index) => ({ index, row }))
      .filter(({ row }) => row.rung === rung)
      .sort((a, b) => b.row.valueMinor - a.row.valueMinor || a.index - b.index)
      .map(({ row }) => row),
  })).filter((group) => group.rows.length > 0);
}

export function realCatalog(
  assets: readonly ManualAsset[],
  privacyMode: boolean,
): CatalogRow[] {
  return assets.map((asset) => ({
    code: asset.securityId?.value ?? asset.providerSymbol ?? null,
    id: asset.id,
    name: asset.name,
    rung: asset.liquidityTier,
    valueLabel: formatMoneyMinorPrivacy(asset.currentValue, privacyMode),
    valueMinor: asset.currentValue.amountMinor,
  }));
}

// ── Catálogo sintético ─────────────────────────────────────────────────────
// Inventado, con la forma de una cartera real grande: decenas de fondos con
// nombres casi gemelos, entradas crípticas, planes con código DGS y unos pocos
// coches, inmuebles y cuentas. Ningún dato real.

type SyntheticEntry = [name: string, code: string | null, euros: number];

const SYNTHETIC: Record<LiquidityTier, SyntheticEntry[]> = {
  cash: [
    ["Cuenta corriente BBVA", null, 8_420],
    ["Cuenta remunerada Trade Republic", null, 21_300],
    ["Depósito a la vista Openbank", null, 4_150],
    ["Efectivo en casa", null, 600],
  ],
  housing: [
    ["Piso Madrid (vivienda habitual)", null, 385_000],
    ["Apartamento en la playa", null, 172_000],
    ["Plaza de garaje", null, 24_000],
  ],
  illiquid: [
    ["Coche familiar", null, 14_500],
    ["Moto", null, 3_800],
    ["Oro físico (monedas)", null, 9_200],
    ["Colección de monedas", null, 2_100],
  ],
  market: [
    ["Vanguard Global Stock Index Fund", "IE00B03HCZ61", 61_240],
    ["Vanguard Global Stock Index Fund", "IE00B03HD191", 8_310],
    ["Fidelity MSCI World Index Fund", "IE00BYX5NX33", 48_210],
    ["Fidelity MSCI World Index Fund", "IE00BYX5MX67", 9_800],
    ["iShares Core MSCI World UCITS ETF", "IE00B4L5Y983", 33_120],
    ["iShares Core MSCI World UCITS ETF", "SWDA.L", 2_940],
    ["iShares Developed World Index Fund", "IE00BD0NCM55", 27_400],
    ["iShares Emerging Markets Index Fund", "IE00B3D07G23", 7_950],
    ["iShares Europe Index Fund", "IE00BDRK7T12", 5_210],
    ["iShares US Index Fund", "IE00BDRK7Y64", 12_660],
    ["iShares Japan Index Fund", "IE00BDRK7J14", 3_120],
    ["iShares Pacific Index Fund", "IE00BDRK7S21", 2_480],
    ["Vanguard Emerging Markets Stock Index Fund", "IE0031786696", 6_730],
    ["Vanguard European Stock Index Fund", "IE0007987690", 4_920],
    ["Vanguard U.S. 500 Stock Index Fund", "IE0032126645", 15_870],
    ["Vanguard Global Small-Cap Index Fund", "IE00B42W4L06", 11_340],
    ["Vanguard Global Bond Index Fund", "IE00B18GC888", 19_500],
    ["Vanguard Euro Government Bond Index Fund", "IE0007472115", 8_100],
    ["Vanguard FTSE All-World UCITS ETF", "IE00BK5BQT80", 22_780],
    ["Vanguard LifeStrategy 80% Equity", "IE00BMVB5R75", 13_450],
    ["Amundi Index MSCI World", "LU0996182563", 17_640],
    ["Amundi Index MSCI Emerging Markets", "LU0996177134", 4_330],
    ["Amundi Index MSCI Europe", "LU0389811885", 3_910],
    ["Amundi Prime Global UCITS ETF", "IE0009DRDY20", 6_020],
    ["Amundi Index Euro Govies", "LU1437016204", 2_750],
    ["Xtrackers MSCI World Swap UCITS ETF", "LU0274208692", 5_880],
    ["Xtrackers MSCI Emerging Markets", "IE00BTJRMP35", 3_460],
    ["Xtrackers S&P 500 Swap UCITS ETF", "LU0490618542", 9_120],
    ["SPDR MSCI ACWI IMI UCITS ETF", "IE00B3YLTY66", 7_210],
    ["Invesco EQQQ Nasdaq-100 UCITS ETF", "IE0032077012", 4_640],
    ["Pictet Global Megatrend Selection", "LU0386882277", 3_380],
    ["Pictet Water", "LU0104884860", 2_190],
    ["Robeco Global Consumer Trends", "LU0187079347", 1_870],
    ["Cobas Internacional FI", "ES0119199000", 6_450],
    ["Cobas Selección FI", "ES0124037005", 4_180],
    ["Azvalor Internacional FI", "ES0112611001", 7_960],
    ["Magallanes European Equity FI", "ES0159259029", 3_740],
    ["True Value FI", "ES0179555008", 2_260],
    ["Bestinver Internacional FI", "ES0114638036", 5_330],
    ["Baelo Patrimonio FI", "ES0164838008", 1_990],
    ["Indexa Capital — cartera 10/10", null, 31_870],
    ["MyInvestor Indexado Global FI", "ES0165242002", 8_740],
    ["MyInvestor S&P 500 Equiponderado", "ES0165243000", 4_010],
    ["DWS Floating Rate Notes", "LU1534073041", 9_430],
    ["Groupama Trésorerie", "FR0000989626", 12_100],
    ["Fondo monetario Caixabank", "ES0158967036", 6_800],
    ["0P0001U3CO.F", "0P0001U3CO.F", 3_270],
    ["0P00000LFM.F", "0P00000LFM.F", 1_540],
    ["Apple Inc.", "US0378331005", 6_180],
    ["Microsoft Corp.", "US5949181045", 7_430],
    ["Alphabet Inc. Class A", "US02079K3059", 3_920],
    ["Berkshire Hathaway B", "US0846707026", 4_870],
    ["Iberdrola", "ES0144580Y14", 2_640],
    ["Inditex", "ES0148396007", 3_150],
    ["Banco Santander", "ES0113900J37", 1_230],
    ["Telefónica", "ES0178430E18", 860],
    ["Realty Income", "US7561091049", 2_310],
    ["Bitcoin", null, 11_200],
    ["Ethereum", null, 3_480],
  ],
  "term-locked": [
    ["N5396 - Indexa Más Rentabilidad Acciones PP", "N5396", 28_400],
    ["N5138 - MyInvestor Indexado Global PP", "N5138", 9_150],
    ["N4999 - Plan de empleo empresa", "N4999", 16_720],
    ["N0123 - Plan individual Caixabank", "N0123", 4_380],
    ["Depósito a 12 meses Renault Bank", null, 10_000],
  ],
};

export function syntheticCatalog(privacyMode: boolean): CatalogRow[] {
  return (
    LIQUIDITY_LADDER.flatMap((rung) =>
      SYNTHETIC[rung].map(([name, code, euros], index) => ({
        code,
        id: `proto-${rung}-${index}`,
        name,
        rung,
        valueLabel: formatMoneyMinorPrivacy(
          { amountMinor: euros * 100, currency: "EUR" },
          privacyMode,
        ),
        valueMinor: euros * 100,
      })),
    )
      // El catálogo real no llega ordenado por nada útil: se baraja de forma
      // determinista para que el prototipo no haga trampa con el orden de entrada.
      .map((row, index) => ({ key: (index * 37) % 101, row }))
      .sort((a, b) => a.key - b.key)
      .map(({ row }) => row)
  );
}

/** Tres ids marcados para simular «editar un objetivo»: dos fondos y un plan. */
export function editScenarioIds(rows: readonly CatalogRow[]): string[] {
  const market = rows.filter((row) => row.rung === "market").slice(0, 2);
  const plan = rows.filter((row) => row.rung === "term-locked").slice(0, 1);
  return [...market, ...plan].map((row) => row.id);
}

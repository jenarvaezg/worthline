import type { SyncRun } from "@worthline/db";
import type { SourcePosition } from "@worthline/domain";

/**
 * La carga de datos de `/ajustes/conexiones` (#1223, PRD #1222).
 *
 * La página no sabe nada de Numista ni de Binance: itera el registry y, por cada
 * adapter, busca su fuente conectada y le pide al propio adapter cómo se cuenta
 * lo que materializa y de dónde sale su valor. Añadir una fuente es una entrada
 * más en el registry — cero código nuevo aquí.
 *
 * Este módulo se queda con la parte de DATOS de esa definición (nada de JSX ni
 * de Server Actions) para poder probarlo con un store falso y sin arrastrar el
 * módulo de acciones.
 */

/**
 * Los adapters que la sección conoce, EN ORDEN DE TABLA. Vive aquí, en el módulo
 * sin JSX ni Server Actions, porque `/ajustes` solo necesita la lista para contar
 * («2 de 2 conectadas») y no tiene por qué arrastrar la capa de render.
 */
export const CONNECTION_ADAPTERS = ["numista", "binance"] as const;

export type ConnectionAdapter = (typeof CONNECTION_ADAPTERS)[number];

/** Un activo tal y como lo lee esta página: su id y su valor actual. */
export interface ConnectionValueAsset {
  id: string;
  currentValue: { amountMinor: number };
}

/** El contexto con el que un adapter calcula el valor de su fuente. */
export interface ConnectionValueContext {
  assets: readonly ConnectionValueAsset[];
  /** El activo espejo de la fuente (`connected_sources.asset_id`). */
  primaryAssetId: string;
  /** TODOS los activos de la fuente — una fuente puede ocupar varios peldaños. */
  sourceAssetIds: readonly string[];
}

/** La parte de datos de una entrada del registry. */
export interface ConnectionDataDefinition {
  adapter: string;
  /** Cuántos elementos materializa la fuente (monedas, tokens…). */
  countUnits: (positions: readonly SourcePosition[]) => number;
  valueMinor: (context: ConnectionValueContext) => number;
}

/** La fila de `connected_sources` que esta página necesita. */
export interface ConnectionSourceRow {
  adapter: string;
  assetId: string;
  id: string;
  lastSyncAt: string | null;
}

export interface ConnectionRowStore {
  listSourceAssetIds: (sourceId: string) => Promise<string[]>;
  readPositions: (sourceId: string) => Promise<SourcePosition[]>;
  /** Las corridas retenidas de la fuente, newest-first (`sync_run`, #1224). */
  readRuns: (sourceId: string) => Promise<SyncRun[]>;
}

export interface ConnectionRow {
  adapter: string;
  /** Ficha del activo espejo, o null si el holding ya no tiene id público (#1318). */
  fichaHref: string | null;
  /**
   * Las corridas de sync retenidas, newest-first — la primera es la última
   * corrida y de ella sale la salud de la fila (#1224). Vacío sin conectar.
   */
  runs: readonly SyncRun[];
  /** null = adapter disponible pero sin conectar. */
  source: { assetId: string; id: string; lastSyncAt: string | null } | null;
  unitCount: number;
  valueMinor: number;
}

/**
 * Una fila por entrada del registry, en el orden del registry: las conectadas
 * con sus cifras y las que no, vacías. Un adapter sin fuente no cuesta ninguna
 * lectura.
 */
export async function loadConnectionRows({
  assets,
  definitions,
  hrefOf,
  sources,
  store,
}: {
  assets: readonly ConnectionValueAsset[];
  definitions: readonly ConnectionDataDefinition[];
  hrefOf: (assetId: string) => string | null;
  sources: readonly ConnectionSourceRow[];
  store: ConnectionRowStore;
}): Promise<ConnectionRow[]> {
  return Promise.all(
    definitions.map(async (definition): Promise<ConnectionRow> => {
      const source = sources.find((row) => row.adapter === definition.adapter);

      if (!source) {
        return {
          adapter: definition.adapter,
          fichaHref: null,
          runs: [],
          source: null,
          unitCount: 0,
          valueMinor: 0,
        };
      }

      // Las tres lecturas van siempre, también para un adapter de un solo peldaño
      // que no mire `sourceAssetIds` (Numista): el contrato es el mismo para
      // todos y son tres consultas indexadas por fuente conectada — como mucho
      // una tanda por entrada del registry, y solo si está conectada.
      const [positions, sourceAssetIds, runs] = await Promise.all([
        store.readPositions(source.id),
        store.listSourceAssetIds(source.id),
        store.readRuns(source.id),
      ]);

      return {
        adapter: definition.adapter,
        fichaHref: hrefOf(source.assetId),
        runs,
        source: {
          assetId: source.assetId,
          id: source.id,
          lastSyncAt: source.lastSyncAt,
        },
        unitCount: definition.countUnits(positions),
        valueMinor: definition.valueMinor({
          assets,
          primaryAssetId: source.assetId,
          sourceAssetIds,
        }),
      };
    }),
  );
}

# Audit: performance y oportunidades de caché (julio 2026)

> **Origen:** análisis en profundidad (sesión jul 2026).  
> **Mapa wayfinder:** [#783](https://github.com/jenarvaezg/worthline/issues/783).  
> **Presupuestos:** `docs/performance-budgets.md`, harness `tests/performance-harness.integration.test.ts`.

## TL;DR

Worthline ya cachea en **Turso** (precios, snapshots, benchmarks) y en **cliente** (matrix prefetch, ADR 0038). No usa Redis ni Next.js Data Cache (`unstable_cache`, `revalidateTag`). El mayor gap no es “falta de caché distribuida” sino **I/O de red y escrituras en el GET del dashboard**, **upserts seriales**, **doble `openStore` en `/`**, y **N+1** en rutas secundarias.

---

## Estado actual de caché (baseline)

| Capa           | Qué                                                   | Dónde                                                      |
| -------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| DB             | `asset_price_cache` con TTL (`PRICE_TTL_DAYS`)        | `packages/domain/src/prices.ts`, `refresh-stale-prices.ts` |
| DB             | Snapshots diarios + cron 21:00 UTC                    | ADR 0037, `capture-daily-snapshot.ts`                      |
| DB             | `benchmark_prices` (control plane)                    | `control-plane.ts`                                         |
| Request        | `React.cache()` — `readStoreTarget`, `getPrivacyMode` | `read-store-target.ts`, `read-privacy-mode.ts`             |
| Store lifetime | `getWorkspace()` promise-memoized                     | `store-context.ts`                                         |
| Dashboard      | `buildProjectionContext()` una vez (#566)             | `load-dashboard.ts:263`                                    |
| Cliente        | Matrix cells + prefetch `/api/dashboard/cells`        | ADR 0038, `composition-panel.tsx`                          |
| PWA            | Cache-first solo estáticos; figuras network-first     | `public/sw.js`                                             |

**Ausente a propósito:** Redis, `unstable_cache`, ISR, CDN cache en APIs financieras.

---

## Inventario de call sites — priorizado

### P0 — Critical path (cada visita a `/`)

| ID    | Anti-patrón                             | Call sites                                                                                                           | Fix propuesto                                          | Ticket wayfinder                                                                                                       |
| ----- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| P0-1  | **Refresh precios + sync en GET**       | `load-dashboard.ts:201–245` — `refreshPrices`, `refreshCoinValuations`, `refreshBinanceSources` antes de leer estado | Desacoplar a cron + manual; GET solo lee cache DB      | [#785](https://github.com/jenarvaezg/worthline/issues/785), [#788](https://github.com/jenarvaezg/worthline/issues/788) |
| P0-2  | **`upsertPrice` serial post-refresh**   | `load-dashboard.ts:217–225`, `refresh-prices.ts:60–62`                                                               | ~~`upsertPrices([])` en transacción~~ **Hecho (#786)** | [#786](https://github.com/jenarvaezg/worthline/issues/786)                                                             |
| P0-2b | **`upsertPrice` serial (mismo patrón)** | `run-daily-capture.ts`, `inversiones/actions.ts` refresh path                                                        | ~~Mismo batch seam~~ **Hecho (#786)**                  | [#786](https://github.com/jenarvaezg/worthline/issues/786)                                                             |
| P0-3  | **Doble `openStore` en home**           | `page.tsx:42–70` (shell) + `dashboard-content.tsx:477–511` (body)                                                    | Un store por request o shell sin `readAssets`          | [#787](https://github.com/jenarvaezg/worthline/issues/787)                                                             |

### P1 — Alto impacto (payload, CPU, o rutas frecuentes)

| ID   | Anti-patrón                                        | Call sites                                                                                                                                        | Fix propuesto                                                        | Ticket wayfinder                                           |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| P1-1 | **`compositionSeriesByRange` eager**               | `load-dashboard.ts:416–428` — `buildCompositionSeries` × N rangos                                                                                 | Solo rango activo; resto vía `/api/dashboard/cells`                  | [#789](https://github.com/jenarvaezg/worthline/issues/789) |
| P1-2 | **`matrixCells` cross prefetch en RSC**            | `load-dashboard.ts:469–475` — `buildMatrixCells` para cross completo                                                                              | Ya parcialmente cubierto por ADR 0038; revisar si cross mínimo basta | [#789](https://github.com/jenarvaezg/worthline/issues/789) |
| P1-3 | **CPI: control plane sin memo + helper duplicado** | `dashboard-content.tsx:73–84`, `agent-view/http.ts:68–79`, `agent-view/internal-catalog.ts:46–57` (canonical: `build-holding-benchmark.ts:10–23`) | `React.cache()` por request o consolidar import                      | [#790](https://github.com/jenarvaezg/worthline/issues/790) |
| P1-4 | **N+1 `readOperations` — agent financial context** | `agent-view/financial-context.ts:313–324` — `Promise.all` sobre rows, una query por inversión                                                     | `readAllOperations` / projection context                             | Fog → ticket post-#783                                     |
| P1-5 | **N+1 `readOperations` — import preview**          | `importar-extracto/actions.ts:310–318` — `readPortfolioInvestments`                                                                               | `readAllOperations` (ya en `buildProjectionContext`)                 | Fog                                                        |
| P1-6 | **N+1 `readOperations` — ajustes savings**         | `ajustes/page.tsx:128–134`                                                                                                                        | `readAllOperations` o projection context                             | Fog                                                        |
| P1-7 | **`readAssets()` full scan para un id**            | `patrimonio/actions.ts:314, 388, 519, 580, 628` — `findAsset`, `updateAssetValuationAction`, etc.                                                 | `readAssetById` targeted                                             | Fog                                                        |
| P1-8 | **Matrix drill: full asset/liability projection**  | `dashboard-cells.ts:117–120` — `readAssets` + `readLiabilities` + `readTrash` para ids                                                            | `SELECT id` narrow query                                             | Fog                                                        |

### P2 — Escala / cron / rutas menos frecuentes

| ID   | Anti-patrón                                    | Call sites                                                                             | Fix propuesto                        |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| P2-1 | **Cron: workspaces secuenciales**              | `run-daily-capture.ts:131–182` — `for` workspace + `upsertPrice` serial L155–171       | `Promise.all` con concurrency limit  |
| P2-2 | **Cron: benchmark upserts seriales**           | `control-plane.ts:342–352` — loop `execute` por fila CPI                               | Batch INSERT                         |
| P2-3 | **Capture: sources secuenciales**              | `capture-daily-snapshot.ts:72–109` — `for (source of listSources)` + `readPositions`   | `Promise.all` sobre sources          |
| P2-4 | **Binance/Numista refresh secuencial**         | `refresh-binance-sources.ts:61`, `refresh-coin-valuations.ts` (mismo patrón)           | Paralelizar si >1 source (hoy 0–2)   |
| P2-5 | **`listSources()` duplicado**                  | `patrimonio/[id]/editar/page.tsx:136, 159`                                             | Una lectura, reusar en closure       |
| P2-6 | **Histórico: reads seriales independientes**   | `historico/page.tsx:40–46` — snapshots luego holdingRecords                            | `Promise.all`                        |
| P2-7 | **Agent-view N+1 debt/freshness/positions**    | `data-quality.ts:371, 442, 539`; `connected-sources.ts:50`; `financial-context.ts:358` | Bulk seams en `AgentViewReadStore`   |
| P2-8 | **Agent returns N+1**                          | `agent-view/returns.ts:115` — `readOperations` por holding                             | Bulk operations map                  |
| P2-9 | **Chat rate-limit: CP open/close por request** | `asistente/rate-limit-store.ts` (control plane)                                        | Request-scoped memo si volumen crece |

### Ya mitigado (no re-auditar)

| Qué                                   | Evidencia                                                    |
| ------------------------------------- | ------------------------------------------------------------ |
| Dedup projection context en dashboard | `load-dashboard.ts:255–263` (#566)                           |
| Snapshot capture solo self-heal       | `load-dashboard.ts:276–297` (ADR 0037)                       |
| Parallel reads patrimonio/objetivos   | `patrimonio/page.tsx:93–117`, `objetivos/page.tsx:168–183`   |
| Fleet price dedup en cron             | `run-daily-capture.ts:146–151`                               |
| Hot-read indexes                      | `packages/db/tests/hot-read-indexes.persistence.test.ts`     |
| Refresh concurrency cap (externo)     | `REFRESH_CONCURRENCY_LIMIT = 4` en `refresh-stale-prices.ts` |

---

## Qué NO cachear (out of scope del mapa #783)

- **Redis / KV distribuido** — Turso es la caché cross-request.
- **CDN cache en APIs con figuras** — `no-store` en dashboard cells, agent-view, chat.
- **`force-dynamic` antes de quitar writes del GET** — ver `docs/agents/274-deployment-and-architecture-report.md` §6.
- **Ripples de snapshot en mutaciones** — deben seguir siendo síncronos (ADR 0012).

---

## Orden de ejecución sugerido (post-decisiones wayfinder)

1. Cerrar [#785](https://github.com/jenarvaezg/worthline/issues/785) (staleness) → [#788](https://github.com/jenarvaezg/worthline/issues/788) (contrato loadDashboard)
2. [#786](https://github.com/jenarvaezg/worthline/issues/786) batch upsert — paralelo, quick win
3. [#787](https://github.com/jenarvaezg/worthline/issues/787) store único en home
4. [#789](https://github.com/jenarvaezg/worthline/issues/789) lazy composition series
5. [#790](https://github.com/jenarvaezg/worthline/issues/790) CPI cache
6. Tickets `ready-for-agent` de implementación para P1 N+1 y P2 cron (crear al cerrar mapa)

Cualquier implementación debe **bajar** ceilings en `THRESHOLDS_MS` del harness, no subirlos.

# Informe #274 — Despliegue a coste cero (cloud) y replanteamiento de arquitectura

> Issue: [#274](https://github.com/jenarvaezg/worthline/issues/274) — _Análisis: opciones de despliegue gratuito (0 coste) fuera de local_
> Tipo: research/analysis. Este documento es el deliverable.
> Fecha: 2026-06-17. (Reescribe una primera versión que recomendaba self-host; el objetivo real es desplegar en una plataforma cloud gratuita, aceptando cambiar la base de datos.)

---

## 1. TL;DR / Recomendación

**No existe la opción "desplegar worthline tal cual".** `better-sqlite3` es síncrono, nativo y escribe a un fichero en disco local — no sobrevive en serverless (FS efímero) y no tiene equivalente async. Toda plataforma cloud gratuita obliga a **cambiar la BD a un driver async** (libSQL/D1/Postgres), y ese refactor `sync→async` es **el coste real, idéntico en cualquier diana**. La buena noticia: el blast radius es la capa `db` + el pegamento de los server actions (ya `async`); **`packages/domain` (~10k LOC de matemática pura) no se toca**.

| Eje                   | Recomendación                                | Por qué (1 línea)                                                                                                                                                                                 | Alternativa                                                                                                                                    |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plataforma**        | **Vercel Hobby**                             | La app YA es Next.js (RSC + server actions + SVG de servidor); host nativo, cero capa de adaptador, free tier inalcanzable a tráfico de 1 usuario                                                 | **Cloudflare Workers/Pages** vía `@opennextjs/cloudflare` (tu ecosistema: ya operas D1 en loquevotan)                                          |
| **Base de datos**     | **Turso / libSQL**                           | Es SQLite de verdad: conserva el dialecto `sqlite-core` de drizzle, ~90% de la escalera de migración y **transacciones interactivas** que mapean 1:1 con los 53 closures actuales; sin cold start | **Cloudflare D1** — solo si vas a CF y aceptas reescribir las migraciones (ver §4: D1 NO tiene transacciones interactivas)                     |
| **Auth**              | **Clerk**                                    | Mejor DX en App Router (`clerkMiddleware()` + `auth()`), free 50k MAU, **agnóstico de BD** (no acopla auth con la decisión de base de datos)                                                      | **Cloudflare Access** (cero código, gate en el edge) si la diana es Cloudflare; **Firebase Auth** (tu instinto) también gratis pero más pesado |
| **Refresco de datos** | **Cron de plataforma → `POST /api/refresh`** | Saca el fetch de precios/sync/snapshot del render (hoy hace I/O de red en cada GET); es tu patrón de `update-data.yml` y arregla la familia del cliff #119/#158                                   | GitHub Action con `schedule` pegando al endpoint                                                                                               |

**Punchline:** la diana de menos fricción es **Vercel + Turso**, conservando casi todo worthline salvo el cambio obligado `sync→async`. La energía va a ese refactor y a desacoplar el I/O del render — no a reescribir el dominio ni a migrar a Postgres.

---

## 2. Inventario técnico actual (criterio de aceptación #1)

| Requisito                         | Realidad en worthline                                                                                                                                                                                                                     | Implicación de despliegue                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Base de datos**                 | `better-sqlite3` (SQLite, **no** Postgres): síncrono, nativo, fichero `.local/worthline/worthline.sqlite`, WAL, drizzle `sqlite-core`, escalera _forward-only_ a **schema v27** que corre `migrate(sqlite)` en cada apertura de conexión. | Necesita **runtime Node**, **bindings nativos** y **FS persistente escribible**. En serverless el FS es efímero → **pérdida total y silenciosa**. Fuerza cambio de BD. |
| **Sincronía (load-bearing)**      | **~279** llamadas síncronas + **53** transacciones en `packages/db/src`; wrapper nativo `sqlite.transaction(work)()` (`store-context.ts:93`). **0 async** en `packages/domain` y `packages/db`.                                           | Todo driver remoto (libSQL/D1/Neon) es **async** → cascada de `await` por la capa db. La matemática de dominio (pura) se queda síncrona.                               |
| **Escrituras + I/O en el render** | `page.tsx` es `force-dynamic`; en cada GET hace `refreshStalePrices` (fetch a 6 providers), sync de fuentes, y **escribe** precio + snapshot (`load-dashboard.ts`).                                                                       | En Vercel, límite de 10s por función → **generador de 504**; y escrituras-on-GET chocan con el FS efímero. Hay que desacoplar (ver §6).                                |
| **Jobs periódicos**               | **No hay cron.** Todo es render-on-demand o botón en `/ajustes`.                                                                                                                                                                          | El refresco debe pasar a un cron de plataforma / GitHub Action contra un endpoint.                                                                                     |
| **Auth / sesiones**               | **Ninguna** (constraint de producto). Bindea a `127.0.0.1`. 8 ficheros `"use server"` mutan por POST sin autenticar.                                                                                                                      | Exponer a internet sin auth = 8 endpoints de escritura abiertos. Necesita auth gestionada (§5).                                                                        |
| **Secretos**                      | `NUMISTA_API_KEY` (env); credenciales Binance en la BD (local-only, nunca exportadas, ADR 0016).                                                                                                                                          | Env → secret store del host. Repo **público**: ningún secreto al git.                                                                                                  |
| **Backups**                       | Export/Import manual (`GET /ajustes/export`, JSON full-workspace, ADR 0010/0015).                                                                                                                                                         | Sirve como herramienta de **cutover** a la BD remota (ver §7).                                                                                                         |
| **Monorepo / build**              | npm workspaces (**no** Turborepo: `turbo.json` vacío). **No** hay `Dockerfile` ni `output: standalone`. `packages/domain` puro (solo `big.js` + `zod`).                                                                                   | Vercel no necesita Dockerfile; un deploy en contenedor (CF/otros) sí requeriría añadirlo.                                                                              |

> **Corrección al texto del issue:** worthline **no** usa Turborepo ni Postgres. Los "paquetes de dominio compartidos" sí existen y son la joya (puros y testeados).

---

## 3. Comparativa de despliegue gratuito (criterios de aceptación #2 y #3)

Free tiers verificados 2026-06-17 (posterior al _cutoff_; cifras marcadas `baja` pueden haber cambiado — re-verificar antes de comprometerse).

| Plataforma             | Free tier (2026)                                                                                               | Confianza                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Vercel Hobby**       | 100 GB BW/mes, 1M invocaciones/mes, 4 CPU-h/mes, límite 10s/función, **solo no-comercial**, sin FS persistente | alta                                                                        |
| **Turso (libSQL)**     | ~5 GB, 500M lecturas/mes, 10M escrituras/mes, **sin cold start**                                               | media (caps exactos 2026 a confirmar; "sin cold start" es el hecho durable) |
| **Cloudflare Workers** | ~100k req/día (sobra para 1 usuario)                                                                           | media                                                                       |
| **Cloudflare D1**      | 5 GB, lecturas/escrituras diarias generosas, sin egress                                                        | baja (los caps exactos bailan en docs)                                      |
| **Neon Postgres**      | 0.5 GB, 100 CU-h/mes, **scale-to-zero obligatorio (cold start al despertar)**                                  | alta                                                                        |
| **AWS**                | Amplify/Lambda ~gratis, pero **RDS free solo 12 meses** → luego factura                                        | alta (el límite de 12 meses lo descalifica)                                 |

A tráfico de 1 usuario/hogar **ningún cap de uso muerde**. Lo que decide es: cuánto código sobrevive, madurez de Next.js en la plataforma, y cold start en el render `force-dynamic`.

### Combos, ordenados

| #     | Combo                                          | Cambio de dialecto                            | Migraciones v2→v27                                       | Transacciones                                  | Next.js                          | Veredicto                            |
| ----- | ---------------------------------------------- | --------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- | -------------------------------- | ------------------------------------ |
| **A** | **Vercel + Turso/libSQL**                      | Ninguno (sqlite-core)                         | **~90% sobrevive** (solo sync→async)                     | **Interactivas** → 53 closures 1:1             | Nativo                           | ✅ **PICK**                          |
| C     | **Cloudflare + D1** (`@opennextjs/cloudflare`) | Ninguno (sqlite)                              | **~50%** (v18/v25 a reescribir con `defer_foreign_keys`) | ❌ **NO interactivas** (solo `batch` estático) | Adaptador OpenNext (maduro 2026) | ⚠️ **RUNNER-UP** con coste real      |
| D     | Cloudflare + Turso                             | Ninguno                                       | ~90%                                                     | Interactivas                                   | Adaptador OpenNext               | Híbrido si los límites de D1 muerden |
| B     | Vercel + Neon (Postgres)                       | **Total** (pg-core + re-tipado money/decimal) | **~0%** (escalera reescrita a DDL Postgres)              | OK                                             | Nativo                           | ❌ más churn + cold start            |
| E     | AWS Amplify/Lambda + RDS                       | Total                                         | ~0%                                                      | OK                                             | —                                | ❌ RDS free solo 12 meses            |

### Pick + alternativa

- **PICK: Vercel Hobby + Turso (libSQL).** Conserva **lo máximo** de worthline: dialecto `sqlite-core` intacto (cero re-tipado de minor-units/decimal-strings), ~90% de la escalera de migración (`user_version`, `table_info`, WAL, rebuilds), Next nativo sin adaptador, y Turso **sin cold start** (el render `force-dynamic` no paga penalización de despertar). El coste inevitable es el refactor `sync→async`, común a toda diana.
- **ALTERNATIVA: Cloudflare + D1.** Es tu ecosistema (ya operas D1 en loquevotan). Pero baja al segundo puesto por dos motivos reales (§4): D1 **no tiene transacciones interactivas** (pelea con tus seams de ripple) y sus migraciones necesitan reescritura. Si lo eliges, **Cloudflare + Turso** es la vía de escape que recupera casi toda la escalera.
- **EVITAR:** Neon (reescritura Postgres + cold start) y AWS RDS (free solo 12 meses).

---

## 4. Análisis de arquitectura (criterio de aceptación #4)

`packages/domain` (~10.2k LOC) es **genuinamente puro** (solo `big.js` + `zod`, cero builtins, cero imports de BD). El acoplamiento a plataforma vive en `packages/db` (`index.ts` ~3.140 LOC + `migrate.ts`), atado a la API síncrona de `better-sqlite3`.

| Opción                                             | Migración                                                 | Mantenibilidad                                       | Coste                    | Rendimiento                  | Tipado e2e                                      | DX                        | Veredicto                                                                       |
| -------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- | ------------------------ | ---------------------------- | ----------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| **Mantener Next + Server Actions + swap a libSQL** | Media (sync→async, sqlite-core intacto)                   | Alta                                                 | 0 €                      | Igual (cliff ya memoizado)   | **Ya resuelto** sin frontera de red             | Excelente                 | ✅ **PRIMARY**                                                                  |
| Mantener + D1                                      | Alta (sync→async + migraciones + seams de ripple a batch) | Media                                                | 0 €                      | Igual                        | Ya resuelto                                     | Adaptador                 | Runner-up con coste                                                             |
| Añadir tRPC                                        | Media                                                     | Dos mecanismos RPC                                   | empuja a hostear backend | +serialización               | **Redundante** con Server Actions (cliente web) | Peor                      | Diferir — solo útil para cliente móvil no-RSC                                   |
| Backend Rust (Axum/Actix)                          | Very-high                                                 | Reintroduce contrato tipado que el monorepo no tiene | —                        | Rápido pero no es el cuello  | Fractura JSON                                   | Pierde RSC + SVG servidor | Evitar                                                                          |
| **Núcleo Rust→WASM del dominio**                   | Alta (port 1:1, no reescritura)                           | Doble mantenimiento temporal                         | 0 €                      | Nativo (no es el desbloqueo) | Intacto (tras el mismo barrel)                  | Diversión/aprendizaje     | **Apuesta aparte → [#280](https://github.com/jenarvaezg/worthline/issues/280)** |

### El coste real: `sync→async` (común a toda diana)

- **Blast radius:** `packages/domain` = **0 cambios** (puro, síncrono). `packages/db` = **alto** (cada `.get/.all/.run`→`await`, métodos `async`, el wrapper de transacción reescrito, `migrate.ts` portado). `apps/web` actions = **bajo** (ya son `export async function`; awaitear es casi gratis). Render = **bajo** (RSC ya async).
- **El crux: el closure de transacción.** `sqlite.transaction(work)()` envuelve closures arbitrarios que **leen, ramifican en JS y escriben** interleavando matemática de dominio. **libSQL tiene transacciones interactivas** → cada closure pasa a `async (tx) => {…}` con `await` dentro: mapeo 1:1. **D1 NO** — solo `db.batch([...])` con todas las sentencias conocidas de antemano; tus seams `…AndRipple` deciden _qué_ escribir según lecturas a mitad → habría que re-arquitecturar cada seam (esfuerzo XL). **Esto descalifica D1 como diana cómoda pese a ser tu ecosistema.**
- **La escalera de migración** usa idioms SQLite (`PRAGMA user_version`/`table_info`, rebuilds v18/v25 con `foreign_keys=OFF`, WAL). En libSQL sobreviven; conviene **dejar de correr `migrate()` en cada apertura** y pasarlo a un paso único en CI/deploy (la BD remota arranca en v27).

### Honestidad sobre tRPC

Las **Server Actions ya dan el tipado end-to-end** que vendería tRPC (56 ficheros importan `@worthline/domain` como llamadas tipadas in-process). tRPC solo gana con un cliente separado no-RSC (el móvil que el README anticipa). **Diferir tRPC es correcto.**

### Dónde encaja Rust→WASM

Es **ortogonal** al deploy (el bloqueo es la BD/IO, no el cómputo). Pero un núcleo WASM **no tiene addon nativo ni builtins** → corre idéntico en runtimes **edge** (Workers/Edge) y en un futuro móvil. No es el desbloqueo de deploy; es una apuesta de portabilidad + aprendizaje, especificada aparte en **[#280](https://github.com/jenarvaezg/worthline/issues/280)**.

---

## 5. Auth gestionada, gratis (el bloqueante y el fix)

Single-user/hogar → cualquier free tier sobra; lo que decide es DX y acoplamiento.

| Proveedor              | Free tier (2026, re-verificar)                        | Integración App Router                                       | Acopla BD              | Fit                                        |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------ | ---------------------- | ------------------------------------------ |
| **Clerk**              | ~50k MAU                                              | **Mínima**: `clerkMiddleware()` + `auth()` por server action | No                     | ✅ **PRIMARY** — mejor DX, agnóstico de BD |
| **Cloudflare Access**  | 50 usuarios                                           | **Cero código** (gate en el edge)                            | No                     | Mejor si la diana es Cloudflare            |
| **Firebase Auth**      | ~50k MAU / 3k DAU (Spark)                             | Media (SDK cliente + verificar token)                        | No                     | Funciona; más pesado                       |
| **Supabase Auth**      | ~50k MAU; **pausa proyectos a 7 días de inactividad** | Baja-media                                                   | Sí (Supabase Postgres) | Solo si la BD fuera Postgres-Supabase      |
| **Auth.js / NextAuth** | Gratis, self-host                                     | Media (tú cableas el adaptador)                              | Tú la traes            | Sin vendor pero más pegamento              |

- **PICK: Clerk** — gatea rutas en el middleware, protege los 8 server actions con una línea, y **no acopla la decisión de auth con la de BD** (sobrevive vayas a Vercel u otra parte).
- **Si vas a Cloudflare → Cloudflare Access** es el runner-up (y arguably el ganador en ese universo): cero código.
- **Firebase** (tu instinto) es válido y gratis, solo menos elegante en App Router.
- Modelo de amenaza: repo **público** → todo secreto al secret store del host, nunca al git; `.local/`/`*.sqlite` ya en `.gitignore`. Registrar el nuevo _trust boundary_ en un ADR.

---

## 6. Agujeros técnicos que revelan tus otros repos

Comparando worthline con `loquevotan` (CF Workers+D1+SPA), `tu-ipc`/`cuentas-publicas` (Vite SPA + Action cron de datos) y `cunhaobot` (App Engine + `cron.yaml`):

1. **🔴 I/O de red + escrituras DENTRO del render (alto).** worthline hace fetch a 6 providers + `upsertPrice` + `saveSnapshot` en cada GET. Tus otras apps **desacoplan**: una Action con cron baja/seedea datos; el render solo **lee**. _Fix:_ `POST /api/refresh` disparado por cron de plataforma/Action hace las escrituras out-of-band; el render pasa a read-only. Desbloquea deploy (evita el 504 de 10s) **y** arregla la familia del cliff #119/#158.
2. **`force-dynamic` en todo es incidental, no esencial (alto).** SSR se gana el sueldo solo en (a) los SVG de servidor (ADR 0009) y (b) los server actions de mutación. En cuanto las escrituras salen del render (gap 1), casi todas las páginas son cacheables/ISR → encoge la superficie serverless.
3. **`migrate()` corre en cada apertura de conexión (medio).** Inviable contra BD de red. _Fix:_ paso único en CI/deploy; usa Export/Import como herramienta de cutover (export JSON local → BD remota fresca en v27 → import). Los datos de worthline **no** son regenerables (a diferencia de tus apps cívicas), así que la escalera es load-bearing y hay que preservarla.
4. **No hay pipeline de deploy (medio).** Tus repos auto-despliegan en `main` tras CI verde (`deploy.yml` gated por `workflow_run`). _Fix:_ copia ese patrón + un `refresh-data.yml` aparte para el gap 1.
5. **`index.ts` = 3.140 LOC (bajo).** Regla 800 max; partir el lifecycle/`withStore`/path/bootstrap _antes_ del refactor async para que el diff sea revisable.
6. **Drift de tooling (bajo, aparcar):** Bun + Biome en repos nuevos vs npm + ESLint/Prettier aquí. Ortogonal al deploy.

---

## 7. Plan de migración paso a paso (criterio de aceptación) — local → Vercel + Turso

1. **Async-ifica `packages/db` detrás del barrel actual**, manteniendo `better-sqlite3` como impl (envuelve las llamadas sync en firmas async). 1 PR revisable, **cero cambio de comportamiento, tests verdes**. _(Antes, opcional: partir `index.ts` — gap 5.)_
2. **`withStore`/`runWith` async** y `await` en los 8 ficheros de actions + 8 lectores de página (ya async → barato).
3. **Saca escrituras del render** → `POST /api/refresh` (cron de Vercel o GitHub Action) hace fetch de precios + sync + snapshot; el dashboard pasa a read-only (gap 1). Quita `force-dynamic` de las rutas ya read-only (gap 2).
4. **Desacopla `migrate()`** del request → paso único en deploy. Cutover de datos: **Export JSON local → BD Turso fresca migrada a v27 → Import** (reusa el mecanismo existente).
5. **Cambia el driver a libSQL** (`drizzle-orm/better-sqlite3` → `drizzle-orm/libsql`); mapea los 53 closures a transacciones interactivas; quita PRAGMA WAL/FK; secretos al env de Vercel.
6. **Auth + deploy:** integra **Clerk** (`clerkMiddleware()` + `auth()` en los 8 actions); añade `deploy.yml` (gated por CI verde) y `refresh-data.yml`. Primer deploy + smoke test (dashboard, refresh, sync Numista/Binance, crear dated fact y verificar ripple, export/import en instancia desechable). Registrar ADR del nuevo trust boundary + decisión de BD.

**Esfuerzo total: L** (sería **XL** si te fueras a D1 por el problema de transacciones).

---

## 8. Riesgos y mitigaciones (criterio de aceptación)

| Riesgo                                                                   | Severidad      | Mitigación                                                                                                               |
| ------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **FS efímero = pérdida total silenciosa** (better-sqlite3 en serverless) | Crítica        | No desplegar SQLite-fichero en functions; cambiar a libSQL (Turso). Razón de §3-§4.                                      |
| **D1 sin transacciones interactivas** rompe los seams de ripple          | Alta (solo D1) | No usar D1 como diana; si CF, usar Turso (combo D).                                                                      |
| **Refactor sync→async incompleto** deja la capa db a medias              | Alta           | Hacerlo tras el barrel en 1 PR sin cambio de comportamiento; el type-checker guía la cascada; tests verdes en cada paso. |
| **Render-time I/O → 504** (límite 10s Vercel)                            | Alta           | Desacoplar a `POST /api/refresh` (gap 1) antes del primer deploy.                                                        |
| **Migración correida por request** contra BD de red                      | Alta           | Paso único en deploy; BD remota arranca en v27.                                                                          |
| **Drift de parida en el cutover** (Export/Import)                        | Media          | Tomar export fresco justo antes del import; import es all-or-nothing (ADR 0010).                                         |
| **Secreto commiteado en repo público**                                   | Alta           | Secretos solo en env de Vercel; rotar cualquier expuesto.                                                                |
| **Caps de free tier post-cutoff**                                        | Media          | Re-verificar Vercel/Turso/Clerk antes de comprometerse; a 1 usuario ningún cap muerde.                                   |
| **Drift de ADR** (agente futuro borra el endpoint/cron como dead config) | Media          | ADR documenta el split refresh/render y el trust boundary.                                                               |

---

## 9. Núcleo Rust→WASM (apuesta aparte)

Te interesó y está especificado como PRD propio: **[#280 — Rust→WASM amortization engine](https://github.com/jenarvaezg/worthline/issues/280)**. Resumen: portar el motor de amortización (el más puro y testeado) a un crate Rust→WASM detrás del barrel `@worthline/domain` intacto, con **parida en enteros minor-units** contra el motor TS (snapshots byte-idénticos, ADR 0008/0012/0019) probada por golden vectors antes de cualquier cutover, y _shadow mode_ dual antes de borrar la impl TS. Encuadre honesto: **portabilidad edge/móvil + aprendizaje, no rendimiento** (el cliff #119/#158 era algorítmico y ya está memoizado). Ortogonal a este informe — no desbloquea el deploy, pero comparte la dirección de "dominio portable".

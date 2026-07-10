# Comparativa de gestores de paquetes — worthline (julio 2026)

> **Mapa wayfinder:** [#804](https://github.com/jenarvaezg/worthline/issues/804).  
> **Ticket:** [#807](https://github.com/jenarvaezg/worthline/issues/807).  
> **Contexto:** [`toolchain-audit.md`](./toolchain-audit.md), motivación [#806](https://github.com/jenarvaezg/worthline/issues/806) (bleeding edge), alcance Bun+Biome confirmado en mapa.

## Pregunta

Para este monorepo (Next 16, workspaces TS, Turbo, deploy prebuilt GH→Vercel, `allowScripts`), ¿qué implica **npm 11** vs **pnpm** vs **Bun**?

## Candidatos evaluados

| Gestor | Versión de referencia | Notas |
|--------|----------------------|-------|
| **npm** (status quo) | 11.14.1 (`packageManager` pin) | Workspaces nativos desde npm 7+ |
| **pnpm** | 10.x | Estándar de facto en monorepos Turbo/Vercel |
| **Bun** | 1.2.x | Alineación con otros repos del maintainer; install + runtime opcional |
| Yarn Berry | — | **Descartado** en esta comparativa: no es el drift de los otros repos ni el ecosistema Turbo-first |

## Matriz de decisión

Leyenda: ✅ fuerte · ⚠️ matizable · ❌ fricción relevante · — neutro

| Criterio | npm 11 | pnpm | Bun (solo PM) | Bun (PM + runtime `bun --bun`) |
|----------|--------|------|---------------|--------------------------------|
| Alineación «bleeding edge» | ⚠️ Actual pero no donde converge el ecosistema monorepo | ✅ Convergente Turbo/Vercel | ✅ Alinea con otros repos | ✅ Máxima; más experimental |
| Install speed (CI/local) | Baseline (~22s `npm ci` local) | ✅ ~2–3× típico; store global | ✅ Más rápido aún en benchmarks | = |
| Disco / duplicación | ❌ ~633MB hoisted | ✅ Content-addressable store | ✅ Similar a pnpm | = |
| Phantom deps | ❌ Hoisting permisivo | ✅ `node_modules` estricto | ⚠️ Linker isolated vs hoisted | ⚠️ |
| Turbo 2.9 | ✅ | ✅ Primera clase | ✅ | ✅ |
| Vercel detecta lockfile | ✅ | ✅ `pnpm-lock.yaml` | ✅ `bun.lock` | ✅ |
| Deploy **prebuilt** (build en GH) | ✅ Hoy | ✅ `pnpm install --frozen-lockfile` + `pnpm exec turbo` | ⚠️ Validar `bun install --frozen-lockfile` + build | ❌ Validar `bun --bun next build` en Node 24 runner *o* cambiar runtime |
| Next 16 + TS workspaces | ✅ | ✅ Camino muy transitado | ⚠️ Issues recientes linker isolated + peers TS ([#29727](https://github.com/oven-sh/bun/issues/29727)) | ⚠️ + posible fallback Node en Vercel según config Next |
| `@libsql/client` + nativos | ✅ sharp/esbuild OK | ✅ `onlyBuiltDependencies` | ⚠️ Probar install + test en Linux CI | ⚠️ |
| Playwright / Vitest | ✅ | ✅ | ⚠️ Probar en CI (suelen ir bien) | ⚠️ |
| `allowScripts` npm 11 | ✅ Nativo | ⚠️ → `onlyBuiltDependencies` en `.npmrc` | ⚠️ Política distinta (`trustedDependencies`) | = |
| Coste migración | — | **Medio** (~1 PR) | **Medio-alto** (misma superficie + PoC CI) | **Alto** (scripts, runtime, Vercel `bunVersion`, re-validar prebuilt) |
| Reversibilidad | — | ✅ | ✅ | ⚠️ |

## Superficie de migración (común a pnpm y Bun)

Independiente del gestor elegido, hay que tocar:

1. **Lockfile** — eliminar `package-lock.json`; generar `pnpm-lock.yaml` o `bun.lock`.
2. **`packageManager`** en root — `pnpm@10.x` o `bun@1.2.x` + Corepack en CI.
3. **Workspaces internos** — `*` → `workspace:*` (pnpm/Bun; npm acepta ambos en migraciones).
4. **`pnpm-workspace.yaml`** (solo pnpm) — `apps/*`, `packages/*`, `tests`.
5. **Root scripts** (~7 usos) — sustituir `npm run X --workspace @worthline/web` por:
   - pnpm: `pnpm --filter @worthline/web run X` o delegar todo a `turbo run` donde aplique.
   - Bun: `bun run --filter @worthline/web X` o turbo.
6. **CI** (`.github/workflows/ci.yml`) — `cache: pnpm` / setup Bun; **unificar install** (hoy doble `npm ci`); frozen lockfile.
7. **Deploy** (`deploy.yml`) — mismo gestor; `vercel build` sigue en runner GH.
8. **Docs** — README, CONTRIBUTING, PR template, `verification-gate.md`, ADRs con `npm run`.
9. **Postinstall policy** — replicar whitelist de esbuild/sharp/fsevents/unrs-resolver.

**No** hace falta cambiar la estructura de workspaces ni `turbo.json` para pnpm. Bun puede necesitar `bunfig.toml` (`linker = "hoisted"`) si el linker isolated rompe `tsc` en packages symlinked.

## Análisis por opción

### A. Mantener npm 11

**Pros:** cero churn; `allowScripts` ya configurado; deploy/CI probados; Next 16 prebuilt estable en Node 24.

**Contras:** menos alineado con objetivo bleeding edge y con repos Bun+Biome; hoisting; sin ganancias de install; no es la dirección Turbo/Vercel documentan para monorepos nuevos.

**Veredicto técnico:** válido si el mapa prioriza riesgo cero sobre modernidad. **No** es la opción que mejor cumple la motivación #806 ni el alcance Bun del mapa.

### B. Migrar a pnpm

**Pros:**

- Camino estándar para **Turbo + Vercel monorepos**; documentación y ejemplos abundantes.
- Installs más rápidos y `node_modules` más pequeño en disco (store global `~/.pnpm-store`).
- Dependencias estrictas — detecta imports no declarados (útil en `packages/*` con exports TS).
- Compatible con deploy prebuilt: build sigue siendo `next build` bajo Node; solo cambia el install.
- `packageManager` + Corepack encajan con el pin actual de npm.

**Contras:**

- Pierde `allowScripts` npm-specific → `onlyBuiltDependencies` manual.
- Un PR de migración + posible ajuste si algún paquete asumía hoisting de npm (poco probable en este repo).
- **No** alinea con Bun de otros repos — es un paso intermedio «monorepo moderno» sin unificar runtime.

**Coste estimado:** 1 PR enfocado + verde en CI/E2E; orden de magnitud **medio** (decenas de ficheros tocados, mayormente mecánico).

**Veredicto técnico:** **mejor relación riesgo/modernidad** para worthline si se quiere mejorar toolchain sin apostar el runtime. Recomendado como **candidato principal** si Bun falla la PoC.

### C. Bun como gestor de paquetes (build/test con Node)

**Pros:**

- **Alineación directa** con otros repos del maintainer.
- Installs muy rápidos; workspaces + lockfile nativos; soporta `catalog:` para deps compartidas (sustituto parcial de syncpack).
- Vercel detecta `bun.lock`; docs oficiales Next+Bun.
- Turbo sigue orquestando; `next build` puede ejecutarse con Node en CI sin `bun --bun`.

**Contras / validaciones obligatorias:**

1. **PoC en Linux CI (Node 24):** `bun install --frozen-lockfile` → `turbo run typecheck lint test` → `next build` → Playwright.
2. **Linker isolated** en monorepos: bugs recientes con resolución TS de peers en paquetes symlinked; mitigación `bun install --linker=hoisted` o esperar fixes 1.3.x.
3. **Packages exportan TS fuente** — Next transpila workspaces; probar que Bun no rompe resolución en `apps/web` imports `@worthline/*`.
4. **`@libsql/client`** — cliente nativo; verificar postinstall en ubuntu-latest.
5. Deploy prebuilt: `vercel build` invoca el build del proyecto — confirmar que respeta el gestor del lockfile.

**Coste estimado:** migración mecánica similar a pnpm **+** 1 ticket `task`/PoC de CI obligatorio antes de merge.

**Veredicto técnico:** **candidato preferido por alineación** con el objetivo del mapa, **condicionado** a PoC verde en CI. No asumir sin evidencia en runner Linux Node 24.

### D. Bun gestor + runtime (`bun --bun` en dev/build/start)

**Pros:** máximo rendimiento CPU en dev/build; coherencia total con stack Bun de otros repos; Vercel `bunVersion: "1.x"` para Functions.

**Contras:**

- **Mayor superficie de riesgo:** Next 16 en Bun runtime no es idéntico a Node; informes de fallback Node en Vercel según flags Turbopack.
- Deploy prebuilt hoy explícitamente en **Node 24** por inestabilidad Vercel+Next 16 — añadir variable Bun runtime multiplica incógnitas.
- `next-auth` beta, MCP SDK, AI SDK — menos transitado bajo Bun que bajo Node.
- Playwright E2E arranca `next start` — hay que validar bajo Bun o mantener Node solo para E2E (inconsistencia).

**Veredicto técnico:** **defer** a un esfuerzo posterior o ticket `prototype` separado. No mezclar con el primer salto de gestor. Encaja en fog del mapa como «fase 2» si la fase 1 (Bun PM + Node build) es verde.

## Compatibilidad Vercel (resumen)

| Capa | npm | pnpm | Bun |
|------|-----|------|-----|
| Detección por lockfile | ✅ | ✅ | ✅ |
| Install en build Vercel | ✅ | ✅ | ✅ |
| **Build prebuilt en GH** (caso worthline) | ✅ actual | ✅ esperado | ⚠️ PoC requerida |
| Runtime Functions (`bunVersion`) | Node default | Node default | ✅ opcional, independiente del PM |

Worthline **no usa** el build sandbox de Vercel hoy; la pregunta crítica es **GH Actions**, no la UI de Vercel.

## Recomendación para [#809](https://github.com/jenarvaezg/worthline/issues/809)

Orden sugerido de preferencia dado motivación #806 + alcance Bun del mapa:

1. **Bun (solo PM, Node para build/test/E2E)** — si PoC CI verde en 1 PR de spike.
2. **pnpm** — si la PoC Bun falla o el linker/TS bloquea; sigue siendo bleeding-edge «monorepo moderno».
3. **npm 11** — solo si se explícitamente prioriza cero churn sobre alineación.

**No recomendado en el primer salto:** Bun runtime (`bun --bun`) en producción/E2E.

**Estrategia de ejecución sugerida:**

```
Spike/Bun PoC (task, AFK) ──► verde? ──► merge Bun PM
                              └── rojo? ──► merge pnpm
```

pnpm y Bun no requieren decidir Biome en el mismo PR; Biome es ortogonal ([#808](https://github.com/jenarvaezg/worthline/issues/808)).

## Preguntas abiertas para #809 (grilling)

1. ¿Aceptamos un **spike PR** de Bun en CI antes de decidir, o preferís ir directo a pnpm sin PoC?
2. Si Bun PM funciona pero con `linker=hoisted`, ¿es aceptable (pierde algo de estrictitud isolated)?
3. ¿Unificar Node a **24** en CI+deploy+local en el mismo esfuerzo, o ticket aparte?

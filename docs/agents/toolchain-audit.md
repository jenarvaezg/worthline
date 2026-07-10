# Toolchain audit — worthline monorepo (julio 2026)

> **Mapa wayfinder:** [#804](https://github.com/jenarvaezg/worthline/issues/804).  
> **Ticket:** [#805](https://github.com/jenarvaezg/worthline/issues/805).

## Resumen ejecutivo

Monorepo npm workspaces pequeño (~781 ficheros TS/TSX) con stack moderno ya montado (Turbo 2.9, Next 16, Vitest, Playwright, Husky). No hay dolores medidos; la oportunidad es **modernizar y alinear** (pnpm/Bun/Biome, pins, auto-updates). Fricciones objetivas: **drift Node 24/26**, **15+ deps en `latest`**, **CI instala dos veces**, **sin remote Turbo cache**, **ESLint custom no trivial de portar a Biome**, **deploy prebuilt atado a Node 24 + npm** por fallo histórico del build nativo de Vercel con Next 16.

## Inventario

| Capa | Estado actual | Cableado en |
|------|---------------|-------------|
| Gestor | npm 11.14.1 workspaces (`packageManager` en root) | `package.json`, `package-lock.json` |
| Monorepo | 5 workspaces: `apps/web`, `packages/{db,domain,pricing}`, `tests` | `workspaces` root |
| Orquestación | Turbo 2.9.18, `turbo.json` con build/typecheck/test/lint | CI `npm run *`, root scripts |
| Runtime Node | `engines: >=24`; CI **26**; deploy **24** | `package.json`, `.github/workflows/*` |
| Lint | ESLint flat + `eslint-config-next` + guardrails #361/R14 | `eslint.config.mjs`, per-package `lint` |
| Format | Prettier (separado) | `.prettierrc.json`, `lint-staged`, `npm run format` |
| Test unit | Vitest (config por paquete + root) | `vitest.config.ts` × 6 |
| E2E | Playwright (3 configs) | `playwright*.config.ts`, job CI dedicado |
| Git hooks | Husky pre-commit → lint-staged; prepare-commit-msg (strip AI trailers) | `.husky/` |
| Deploy | **Prebuilt** en GH Actions Node 24 → `vercel deploy --prebuilt` | `deploy.yml`, `apps/web/vercel.json` |
| Seguridad installs | `allowScripts` (esbuild, fsevents, sharp, unrs-resolver) | root `package.json` |
| Auto-updates deps | **Ninguno** (sin Renovate/Dependabot) | — |
| Remote cache Turbo | **No** configurado | — |
| Pin Node local | Solo `engines`; sin `.nvmrc` / mise | — |

## Métricas (macOS, jul 2026, cache caliente)

| Métrica | Valor |
|---------|-------|
| `package-lock.json` | 11 202 líneas |
| `node_modules` | ~633 MB |
| `npm ci` | ~22 s |
| `npm run typecheck` (turbo) | ~11 s |
| `npm run lint` (turbo + root eslint) | ~10 s |
| `npm audit` | 6 moderate, 0 high/critical |
| Ficheros TS/TSX (apps, packages, tests, e2e, scripts) | ~781 |

## Postinstall / nativos

Paquetes con `hasInstallScript` en el lockfile: **esbuild** (3 versiones anidadas: 0.18, 0.25, 0.28), **sharp** (Next), **fsevents** (×2), **unrs-resolver** (eslint). Política explícita vía `allowScripts` npm 11 — hay que replicar equivalente al cambiar de gestor.

## Deps flotantes (`latest`)

Root: `eslint`, `eslint-config-next`, `prettier`, `typescript`, `vitest`, `tsx`, `@types/node`.  
`apps/web`: `next`, `react`, `react-dom`, tipos React.  
`packages/db`: `@libsql/client`, `drizzle-orm`.

Paradójicamente para un objetivo «bleeding edge controlado»: el lockfile fija versiones en CI, pero **no hay PRs automáticas** que empujen updates; `latest` solo afecta installs frescos sin lock.

## Puntos de cableado npm (superficie de migración)

- **Root scripts:** `npm run dev --workspace`, `npm run build --workspace`, etc. (~7 referencias en `package.json` root).
- **CI:** `cache: npm` + `npm ci` en jobs `quality` y `e2e` (doble install por PR).
- **Deploy:** `npm ci` + `vercel build` en Node 24.
- **Docs:** `README.md`, `CONTRIBUTING.md`, PR template, varios ADRs y `docs/agents/verification-gate.md`.
- **Husky:** `npx lint-staged` (gestor-agnóstico).

## Turbo

`turbo.json` activo (no vacío): `build` depende de `^build`, tests dependen de `^typecheck`. Los packages hacen `tsc --noEmit` como «build». Sin `remoteCache` — cada runner de CI reconstruye desde cero salvo cache local de ESLint/Prettier en `node_modules/.cache`.

## ESLint — complejidad para Biome

`eslint.config.mjs` (~93 LOC) incluye:

- `eslint-config-next` (core-web-vitals + typescript).
- **#361:** ban de imports `../` con mensaje custom (aliases `@web`, `@worthline/*`, etc.).
- **R14:** ban de barrel `./index` dentro de `packages/domain/src`.
- Exención `react-hooks/rules-of-hooks` en `e2e/`.

Biome no cubre 1:1 el ecosistema Next ni estas reglas custom sin `overrides`/`nursery` o checks propios — migración es **proyecto**, no swap de config.

## Deploy / Vercel — restricciones para Bun

- **Build de producción:** hoy en **GH Actions Node 24**, no en el sandbox de Vercel, porque Next 16 falló en build nativo Vercel (jun 2026) — ver comentario en `deploy.yml` y ADR 0029.
- **Vercel** detecta npm/yarn/pnpm/Bun como gestores; soporta `bunVersion: "1.x"` en `vercel.json` para **runtime** de Functions/Middleware.
- Implicación: «¿lo soporta Vercel?» tiene **dos ejes** — gestor en monorepo (sí) y **build prebuilt en CI** (hay que validar `bun install` + `bun run build` en Node-alternative, no asumir).

## Workspace interno

- Links `@worthline/*` vía `*` en package.json (npm workspace protocol).
- Packages exportan **TS fuente** (`exports.default: ./src/index.ts`); Next transpila — sin paso de build de paquetes en deploy.

## Hallazgos accionables (input para #807 / #808)

| ID | Hallazgo | Implicación |
|----|----------|-------------|
| T1 | Doble `npm ci` en CI | pnpm/Bun + cache compartida o job único ahorra tiempo; hoy ~44 s install solo en CI |
| T2 | Node 24 deploy vs 26 CI vs `>=24` engines | Pin único (`.node-version` + alinear workflows) — quick win |
| T3 | 15+ `latest` sin Renovate | Contradice «bleeding edge»; Renovate/Dependabot es complemento obvio |
| T4 | `allowScripts` npm-specific | Migración a pnpm → `onlyBuiltDependencies`; Bun → política propia |
| T5 | ESLint custom + Next plugin | Biome viable para format + parte lint; reglas #361/R14 necesitan plan |
| T6 | Prebuilt deploy Node-locked | Bun como **runtime** en Vercel ≠ Bun como **toolchain de build** en CI |
| T7 | 3× esbuild en árbol | Higiene de lockfile; pnpm puede ayudar a visibilidad, no elimina sharp |
| T8 | Sin remote Turbo cache | Ganancia en CI repetido; Vercel Turbo Remote opcional |

## Lo que no está roto

- Workspaces resuelven bien (react deduped, internal links OK).
- Turbo + scripts `verify` coherentes.
- Husky/lint-staged funcionan.
- Phantom deps no auditadas en profundidad (npm hoisting); no hay incidente conocido.

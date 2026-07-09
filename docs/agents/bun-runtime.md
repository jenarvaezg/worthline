# Bun runtime (fase 2)

> **Issue:** [#813](https://github.com/jenarvaezg/worthline/issues/813).  
> **Mapa:** [#804](https://github.com/jenarvaezg/worthline/issues/804).

Fase 1 (Bun PM + Node ejecutando Next) está en `main`. Fase 2 ejecuta **dev / build / start** con el runtime de Bun (`bun --bun next …`) en local, CI y el build prebuilt en GitHub.

## Scripts (`apps/web`)

| Script | Comando |
|--------|---------|
| `dev` | `bun --bun next dev` |
| `build` | link TS deps + `bun --bun next build` |
| `start` | `bun --bun next start` |

Playwright ya invoca `bun run --filter @worthline/web dev|start`; hereda estos scripts.

## Vercel production runtime

**No** usamos `bunVersion` en `vercel.json` todavía.

- Deploy sigue siendo **prebuilt** en GitHub (Node 24 runner + Bun toolchain).
- Las Functions en Vercel siguen en **Node 24.x** (límite de plataforma y menor riesgo con Next 16).
- Añadir `bunVersion: "1.x"` solo tras smoke post-deploy (dashboard, cron snapshot, server actions) en un ticket aparte.

## Validación

- CI **quality** + **e2e**: build y `next start` bajo `bun --bun` (Linux, Node 26 runner).
- Deploy **verify** / `vercel build`: mismo script `build` en runner Node 24.

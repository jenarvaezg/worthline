# Incident 2026-07-10 — Producción 500 `MIDDLEWARE_INVOCATION_FAILED`

**Severidad:** total (500 en TODAS las rutas de `worthline-web.vercel.app`).
**Duración:** desde el deploy de #823 (2026-07-09 ~18:38 UTC) hasta el merge de #847 (2026-07-10 ~08:58 UTC).
**Disparador:** actualización de la **Vercel CLI de 54.21.1 → 55.0.0** (sin cambio de código).

## Síntoma

Toda ruta (`/`, `/sw.js`, `/api/*`) devolvía `500` con `x-vercel-error: MIDDLEWARE_INVOCATION_FAILED`. En los runtime logs:

```
Error [ERR_REQUIRE_ESM]: require() of ES Module
  /var/task/apps/web/.next/server/middleware.js from ___next_launcher.cjs not supported.
  middleware.js is treated as an ES module ... package.json contains "type": "module"
```

## Causa raíz

Cadena completa:

1. `apps/web/proxy.ts` es el "middleware" de Next 16 (auth gate). En Next 16 el `proxy.ts` **siempre corre en el runtime Node.js** — no admite `runtime: 'edge'|'nodejs'` en su `config` (el build falla con *"Proxy always runs on Node.js runtime"*), y `experimental.nodeMiddleware` es una key **inválida** en 16.2.10.
2. Turbopack compila `proxy.ts` a `.next/server/middleware.js` en formato **CommonJS** (`require(...)`, `module.exports`).
3. `apps/web/package.json` declara `"type": "module"` — **obligatorio** para el build: bajo Node, Turbopack exige `type:module` porque la fuente de la app es ESM (con `type:commonjs` el build peta con 263 errores "source is ESM but package is CommonJs").
4. La **Vercel CLI 55.0.0** empaqueta ese proxy como función Node serverless cuyo launcher `___next_launcher.cjs` hace `require()` del `middleware.js`. Como el `package.json` más cercano es `type:module`, Node trata el `.js` (CJS) como ESM → `ERR_REQUIRE_ESM` → la función crashea en cada request → 500.

La **CLI 54.21.1** empaquetaba el proxy de una forma que Node podía cargar; la 55.0.0 cambió ese empaquetado. `bunx vercel` resolvía a *latest*, así que el salto de versión entró solo.

### Evidencia decisiva

Fuente **idéntica**; lo único distinto fue la versión de la CLI:

| Deploy | Commit  | Vercel CLI | Resultado |
|--------|---------|-----------|-----------|
| #822   | abf3a81 | **54.21.1** | ✅ 200 |
| #823   | 8126f61 | **55.0.0**  | ❌ 500 |

Ambos builds registran igual `ƒ Proxy (Middleware)`. El deploy es **prebuilt** (GH Action `bunx vercel build --prod` → `vercel deploy --prebuilt`), no build en Vercel.

## Contexto

El salto de CLI entró con la oleada de toolchain del mapa **#804** (Bun PM, Biome, Turbo, deploy vía `bunx vercel@latest`). El bug estaba **latente** desde el rename `middleware.ts → proxy.ts` (commit `d24aa68`): `proxy.ts` + `type:module` solo funcionaba porque la CLI antigua lo empaquetaba distinto. La actualización de la CLI lo **detonó**.

## Resolución

**PR #847** — fijar la Vercel CLI a `54.21.1` en `.github/workflows/deploy.yml` (env `VERCEL_CLI`, usado en `vercel pull|build|deploy`). Determinista: revierte exactamente la variable que cambió, sin tocar el conflicto ESM/CJS. Verificado tras el merge: `worthline-web.vercel.app/` → **200**, redirige `/`→`/login`.

## Qué se probó y descartó

| Intento | PR | Resultado |
|---------|----|-----------|
| Revertir `bun --bun next build` → `next build` | #845 (MERGED) | No era la causa. Inofensivo; quedó en `main` como parte del estado que funciona. |
| `apps/web/package.json` → `"type": "commonjs"` | #846 (CLOSED) | Rompe el build de Turbopack bajo Node (263 errores; la fuente es ESM). Conflicto real build(ESM)↔runtime(CJS). |
| Turbo Remote Cache (#823) como causa | — | Falso: `vercel build` corre `bun run build` fresco, sin cache hit. |
| `runtime:'edge'` / `runtime:'nodejs'` en `proxy.ts` | — | Next 16 lo prohíbe (route-segment-config no permitido en Proxy). |
| `experimental.nodeMiddleware: true` | — | Key inválida en Next 16.2.10. |

## Pendiente (deuda)

**Desanclar la CLI** cuando se resuelva el conflicto de raíz — issue **#848**. Candidato principal: emitir `apps/web/.next/server/package.json` = `{"type":"commonjs"}` en el build (postbuild) para que los bundles de servidor se resuelvan como CJS pese al `type:module` de la app, **verificando** que Vercel incluye ese `package.json` en el `.func`.

Opcional: #845 puede revertirse para recuperar la intención de #824 (build bajo Bun), pero cambia la combinación hoy probada (`next build` + CLI 54.21.1).

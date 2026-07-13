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
| `.next/server/package.json` = `{type:commonjs}` postbuild, **sin** tocar nft | #848 (probado, descartado solo) | @vercel/nft **no** rastrea un package.json hermano suelto: el marcador queda en disco pero fuera del `filePathMap` de la `.func`. Necesita registrarse en los nft traces. |
| Turbo Remote Cache (#823) como causa | — | Falso: `vercel build` corre `bun run build` fresco, sin cache hit. |
| `runtime:'edge'` / `runtime:'nodejs'` en `proxy.ts` | — | Next 16 lo prohíbe (route-segment-config no permitido en Proxy). |
| `experimental.nodeMiddleware: true` | — | Key inválida en Next 16.2.10. |

## Resolución de raíz — CLI desanclada (#848)

Comparando el `.vc-config.json` de la `_middleware.func` con ambas CLIs sobre la **misma** fuente se ve el cambio exacto que introdujo la 55:

| CLI | entradas en `filePathMap` | ¿`apps/web/package.json` (`type:module`) en el mapa? |
|-----|---------------------------|------------------------------------------------------|
| 54.21.1 (✅) | 90 | **No** |
| 55.0.0 (❌) | 251 | **Sí** |

La 55 rastrea mucho más agresivamente y arrastra el `apps/web/package.json` (`type:module`) dentro de cada función. Con la 54 ningún package.json gobernaba `middleware.js`, así que Node lo cargaba como CJS por defecto; con la 55 el `type:module` gana → `ERR_REQUIRE_ESM`.

**Fix (postbuild):** `scripts/emit-next-server-cjs-marker.ts` emite `apps/web/.next/server/package.json` = `{"type":"commonjs"}` — más cercano a los bundles que el package.json de la app — y **lo registra en los `*.nft.json`** de `.next/server/**` (un package.json hermano suelto **no** lo rastrea @vercel/nft; hay que meterlo en el trace). Verificado con CLI 55.0.0: el marcador aparece en el `filePathMap` de todas las funciones de servidor (middleware, páginas, api) y Node carga los bundles como CJS (`require()` deja de lanzar). `.github/workflows/deploy.yml` sube a `vercel@55.0.0` — pinneado a una versión moderna concreta (no `latest`) para que un salto de CLI no vuelva a detonar prod sin querer.

Opcional (deuda menor): #845 puede revertirse para recuperar la intención de #824 (build bajo Bun), pero cambia la combinación hoy probada.

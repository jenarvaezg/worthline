# Inventario toolchain complementaria — worthline (julio 2026)

> **Mapa wayfinder:** [#804](https://github.com/jenarvaezg/worthline/issues/804).  
> **Ticket:** [#808](https://github.com/jenarvaezg/worthline/issues/808).

## Resumen

| Mejora | ROI | Esfuerzo | Cuándo |
|--------|-----|----------|--------|
| **Biome** (lint+format) | Alto — alinea con otros repos; un tool; CI más rápido | Medio-alto (1 PR grande + guardrails manuales) | PR dedicado; ortogonal a Bun [#812](https://github.com/jenarvaezg/worthline/issues/812) |
| **Renovate** | Alto — 15+ deps `latest` sin auto-update | Bajo | Tras gestor de paquetes estable |
| **Pin Node** (`.node-version` = 24) | Medio — cierra drift CI 26 / deploy 24 | Bajo | Mismo PR que Bun o inmediato después |
| **Remote Turbo cache** | Medio en CI repetido | Bajo-medio | Tras Bun PM; Vercel Remote opcional |
| **syncpack** | Bajo — 5 workspaces, pocos externals | Bajo | Opcional; Bun `catalog:` puede sustituir |
| **knip** | Medio — higiene exports muertos | Medio | Backlog; no bloquea nada |
| **corepack** | — | Incluido en migración Bun/pnpm | Con gestor |

---

## Biome — evaluación profunda

### Viabilidad: **sí, con trabajo manual en guardrails**

Probado con **Biome 2.5.3** contra el repo actual (`biome init` + `biome migrate eslint --include-inspired` + `biome migrate prettier`).

#### Migración automática ESLint → Biome

| Métrica | Valor |
|---------|-------|
| Reglas ESLint detectadas | 113 |
| Migradas a reglas Biome | 70 (62% cobertura directa) |
| Reglas Next no implementadas | 10 (p. ej. `no-html-link-for-pages`, `no-typos`) |
| Reglas React no implementadas | ~32 (mayoría obsoletas / react-in-jsx-scope) |

**Dominio Next:** Biome activa equivalentes de `@next/next/no-img-element` → `noImgElement`, hooks → `useHookAtTopLevel` / `useExhaustiveDependencies`, etc. Los 3 `eslint-disable @next/next/no-img-element` del codebase pasan a `biome-ignore` o se arreglan.

**Prettier:** migración 1:1 — `lineWidth: 90`, `semicolons: always`, `quoteStyle: double`, `trailingCommas: all`, `indentStyle: space`.

#### Gap crítico: guardrails #361 y R14

`biome migrate eslint` habilita `noRestrictedImports` en los overrides correctos (`apps/**`, `packages/**`, `domain/src` sin tests, `e2e` con `useHookAtTopLevel: off`) pero **no porta las opciones** (regex `^\\.\\./` ni ban `./index`).

Hay que añadir manualmente en `biome.json`:

```jsonc
// Override #361 — todos los zones linted
{
  "includes": ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "e2e/**/*.ts", "scripts/**/*.ts"],
  "linter": {
    "rules": {
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "patterns": [{
              "group": ["..", "../*", "../**", "../../**"],
              "message": "Upward relative imports are banned (#361). Use zone aliases or @worthline/*."
            }]
          }
        }
      }
    }
  }
}
```

```jsonc
// Override R14 — domain src (merge con #361 en el mismo override)
{
  "includes": ["packages/domain/src/**/*.ts", "!packages/domain/src/**/*.test.ts"],
  "linter": {
    "rules": {
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "patterns": [
              { "group": ["..", "../*", "../**"], "message": "…#361…" },
              { "group": ["./index", "./index.ts"], "message": "Domain sub-modules must import from leaf files, not the barrel (R14)." }
            ]
          }
        }
      }
    }
  }
}
```

Validar en PR que los patrones gitignore-style cubren la misma superficie que el regex ESLint (hoy **0** imports `../` en el tree — guardrail preventivo).

#### Diagnóstico en codebase (post-migrate config)

| Check | Errores | Notas |
|-------|---------|-------|
| Solo lint | 5 errors, 31 warnings | Mayoría warnings a11y (`useAriaPropsSupportedByRole` ×18), hooks deps ×10 |
| Solo format | 11 | Casi alineado con Prettier |
| Solo assist (`organizeImports`) | **492** | Diff masivo one-shot; decidir si activar en mismo PR |
| **Total** `biome check` | 509 errors | ~97% es format/imports, no regresión lógica |

**Errores lint reales (5):** `noExplicitAny` — ya cubiertos por eslint-disable hoy; migrar a `biome-ignore` o tipar.

#### Cambios de cableado

| Área | De | A |
|------|----|---|
| `verify` | `turbo lint` + `npm run format` | `biome check` (o `turbo` + root `biome check e2e scripts`) |
| `lint-staged` | eslint + prettier | `biome check --write --staged` (o `lint-staged` con biome) |
| Per-package `lint` | `eslint src` | eliminar o `biome check` scoped |
| devDeps | eslint, prettier, eslint-config-next | `@biomejs/biome` |
| CI | lint + format steps | un solo `biome ci` / `biome check` |
| Comentarios | 7× `eslint-disable` | `biome-ignore` equivalente |

#### Riesgos

1. **PR grande** si `organizeImports` va en el mismo commit — considerar `organizeImports: off` inicialmente o PR solo format+lint sin assist.
2. **10 reglas Next sin equivalente** — bajo impacto en worthline (no usamos `no-html-link-for-pages` en disables).
3. **Severity drift:** ESLint tenía varios `@next/*` en warn; Biome migrate los respeta en parte — revisar `noImgElement` (warn vs error).
4. **No rompe Vercel** — lint/format es CI-only; ortogonal a deploy prebuilt.

#### Recomendación Biome

**Aprobar migración** en PR `ready-for-agent` dedicado:

1. Añadir `@biomejs/biome` + `biome.json` final (migrate + guardrails manuales).
2. `biome check --write` con scope acordado (¿imports sí/no?).
3. Quitar ESLint + Prettier.
4. Verde en `verify` + CI.

**Orden sugerido:** PR separado del spike Bun [#812] para evitar conflictos de lockfile; puede ir **en paralelo** en branch distinta o **justo después** del merge Bun PM.

---

## Otras mejoras (resumen)

### Renovate (recomendado sobre Dependabot)

- Agrupa updates por monorepo; entiende `packageManager` y workspaces.
- Resuelve el anti-patrón de 15+ `latest` con PRs semanales controladas.
- Config mínima: `renovate.json` en root, preset `config:recommended`, group `next`+`react`, automerge patch opcional.

### Pin Node `.node-version`

- Fijar **24** (deploy prebuilt) y alinear CI de 26 → 24, o documentar por qué CI usa 26.
- `mise` / `fnm` opcional para DX local.

### Remote Turbo cache

- Sin token hoy; cada job CI reconstruye.
- Tras gestor estable: `TURBO_TOKEN` + `TURBO_TEAM` en GitHub secrets o Vercel integration.

### syncpack / knip

- **syncpack:** bajo valor con 5 workspaces; Bun `catalog:` cubre versión única si se adopta Bun.
- **knip:** útil para exports TS muertos en `packages/*`; segundo PR de higiene.

# Baseline de rendimiento — Phase 0 (junio 2026)

Captura del **antes** exigida por la PRD #485 (_«capturar el baseline de
rendimiento antes de que Phase 0 cambie nada»_) y por la slice gate #516. Es la
porción de medición del spike #486; el audit exhaustivo (Lighthouse/Web Vitals
completos, RUM, priorización de Phase 1) vive en #486.

- **Cuándo**: 2026-06-22.
- **Dónde**: producción, `worthline-web.vercel.app`, deployment
  `dpl_B9hEkCaeYiyMAxTUPK319hHdr2kn`.
- **Contra qué**: el **demo público** (persona `familia`, la más rica). Datos
  ficticios → reproducible y compartible; las timings no son dato financiero.
- **Estado medido**: en caliente (la app ya servida; se descartan cold-starts de
  lambda, anotados aparte).

## Veredicto en una línea

> **De los ~2,7 s de TTFB de cada navegación, ~2,3 s son trabajo de servidor
> contra Turso (el store). El render, el bundle y el swap de documento son
> secundarios. La lentitud es el round-trip a Turso — causa (1) del diagnóstico
> de la PRD, no (2)/(3)/(4).**

Y lo decisivo para Phase 0: **un toggle puro re-ejecuta esos ~2,3 s aunque el
dato no cambie** (cambiar Vista, rango, drill o vivienda cuesta lo mismo que una
carga completa). Eso es exactamente lo que S2/S3/S4 eliminan para los toggles.

## 1. TTFB por superficie (hosted, en caliente, 3 pasadas)

Cada superficie y cada **toggle** (que hoy es un `<Link>` → navegación de
documento) medido con `curl`:

| Superficie / toggle   | TTFB (≈ mediana de 3) |
| --------------------- | --------------------- |
| `/`                   | ~3,0 s                |
| `/?view=liquid`       | ~2,8 s                |
| `/?range=1y`          | ~2,8 s                |
| `/?drill=liquid`      | ~2,7 s                |
| `/?vivienda=oculta`   | ~2,6 s                |
| `/historico`          | ~2,7 s                |
| `/historico?range=3y` | ~2,7 s                |

Rango observado: **2,6–3,0 s**. No hay un toggle «barato»: todos pagan el
round-trip completo.

## 2. Reparto del TTFB: servidor (Turso) vs resto

Vía el seam `[perf]` (`perf-log.ts`, #448) leído de los logs de runtime de Vercel
para el mismo tráfico:

| Ruta         | Etiqueta `[perf]` | Duración servidor (caliente) |
| ------------ | ----------------- | ---------------------------- |
| `/`          | `home-shell`      | ~2,3–2,5 s                   |
| `/historico` | `store`           | ~2,3–2,4 s                   |

→ **~85 % del TTFB es trabajo de store (Turso)**; render + overhead de red ≈
300–400 ms. Cold-start observado puntual: ~4,2 s (primera petición tras idle).

Sospecha para #486 (no confirmada aquí): el dashboard hace **varias queries
secuenciales** a Turso (loadDashboard + movers + refresh); a latencia de
red por query, eso suma. Las palancas de Phase 1 serán región de DB / batching /
caché, no «percibido».

## 3. Bundle / JS servido en `/`

| Métrica                                   | Valor    |
| ----------------------------------------- | -------- |
| Chunks JS referenciados en `/`            | 11       |
| **JS total (sin comprimir)**              | ~916 kB  |
| HTML del documento (gzip, sobre el cable) | ~17,5 kB |

Moderado. No es la causa del lag percibido, pero es la **vara de §11** del doc de
patrones: cada island de Phase 0 se mide contra estos ~916 kB.

## 4. Implicaciones

- **Phase 0 (S1–S6)**: los toggles de cliente (S2/S3/S4) eliminan el round-trip
  de ~2,3 s **al conmutar** — la mejora más demostrable. `useOptimistic` (S5) y
  View Transitions (S1) atacan la _sensación_, no el TTFB. PWA (S6) acelera el
  arranque del shell, no las cifras.
- **Lo que Phase 0 NO arregla**: el **primer paint** sigue costando ~2,3 s de
  store. Eso es Turso, y es trabajo de **Phase 1 (#486)** — región de DB,
  batching de queries, caché. El baseline lo deja explícito para no confundir
  «toggles instantáneos» con «dashboard rápido en frío».

## Cómo reproducir

```sh
BASE=https://worthline-web.vercel.app
JAR=$(mktemp)
# 1) Coger la cookie de persona del demo (familia) y entrar en /
curl -s -o /dev/null -L -c "$JAR" -b "$JAR" "$BASE/demo/persona?persona=familia"
# 2) TTFB por superficie (repetir para calentar)
for p in "/" "/?view=liquid" "/?range=1y" "/?drill=liquid" "/historico"; do
  curl -s -o /dev/null -b "$JAR" -w "$p %{time_starttransfer}s\n" "$BASE$p"
done
```

- **Reparto servidor**: logs de runtime de Vercel filtrando `[perf]` (proyecto
  `worthline-web`), o `mcp__vercel__get_runtime_logs query="[perf]"`.
- **Bundle**: sumar los `content-length` de los `/_next/static/**/*.js`
  referenciados en el HTML de `/`.

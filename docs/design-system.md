# Sistema de diseño de worthline

Guía de estilo del rediseño «mix» (junio 2026). Origen: prototipo de variantes
sobre `/` (bento / informe / denso); ganó **bento con acentos de denso** —
grid de 12 columnas con hero en panel oscuro de tinta y filas de datos densas
con barras embebidas. Toda la implementación vive en tokens y clases de
`apps/web/app/globals.css`; esta guía documenta la intención para que las
páginas nuevas la respeten.

Restricción de base: **cero JS en cliente** (ADR 0009). Todo lo descrito aquí
se consigue con HTML/CSS/SVG server-rendered; la interactividad usa links,
forms POST, `<details>` y `<title>` nativos.

## 1. Tokens (`:root` en globals.css)

| Token                                    | Valor                  | Uso                                                                                                              |
| ---------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--paper`                                | `#eef2ef`              | Fondo de página (con cuadrícula sutil)                                                                           |
| `--panel`                                | `#fffdf7`              | Superficie de tarjeta                                                                                            |
| `--ink`                                  | `#17201e`              | Texto principal, botón primario, nav activa                                                                      |
| `--ink-panel`                            | `#1d2724`              | **El único panel oscuro**: el hero del dashboard                                                                 |
| `--ink-panel-text` / `--ink-panel-muted` | `#e8ece7` / `#9fb0a9`  | Texto sobre el panel oscuro                                                                                      |
| `--muted`                                | `#51605b`              | Texto secundario y labels (≥4.5:1 — testeado)                                                                    |
| `--line` / `--line-strong`               | `#78877f` / `#5d6c66`  | Bordes con significado: controles de formulario, separadores funcionales (≥3:1 WCAG 1.4.11 — `contrast.test.ts`) |
| `--line-soft` / `--hairline`             | `#d9ded7` / `#e4e8e2`  | Bordes decorativos: tarjetas y filas. Nunca el único límite de un control                                        |
| `--green` / `--red`                      | `#006f5f` / `#b9442f`  | **Reservados para deltas y P/L** (+ banners éxito/error)                                                         |
| `--pos-on-dark` / `--neg-on-dark`        | `#5ad4ae` / `#f0907b`  | Deltas sobre el panel oscuro (chips del hero)                                                                    |
| `--blue`                                 | `#245177`              | Acento de interacción: links de acción, hover                                                                    |
| `--gold`                                 | `#b3831f`              | Avisos                                                                                                           |
| `--tier-cash`→`--tier-housing`           | verdes → azules → oro  | Identidad de capas de liquidez (ver §5)                                                                          |
| `--radius` / `--radius-sm`               | `14px` / `8px`         | Tarjetas / controles. Píldoras: `999px`                                                                          |
| `--shadow`                               | corta y suave, 2 capas | **La única elevación.** No inventar sombras nuevas                                                               |

## 2. Jerarquía tipográfica

Tres niveles — cuando todo es énfasis, nada lo es:

1. **Cifra héroe**: `clamp(2.6rem, 5.5vw, 3.8rem)`, peso 760, `letter-spacing
-0.02em`. Solo el patrimonio neto del dashboard.
2. **Títulos de panel** (`h2`): `1rem`, peso 650, **sentence case** — nada de
   uppercase ni letter-spacing.
3. **Labels pequeños** (stats, cabeceras de tabla, `h3`): `0.7–0.78rem`,
   uppercase con `letter-spacing` — es el ÚNICO sitio donde se permite
   uppercase, y siempre en `--muted` o `--ink-panel-muted`.

**Todos los números van en sans con `font-variant-numeric: tabular-nums`** —
nunca en mono. En tablas, las columnas numéricas se alinean a la derecha.
Formato es-ES (`formatMoneyMinor`); porcentajes con coma decimal y signo
explícito ("+3,6 %").

## 3. Superficies y elevación

- Tarjeta estándar: `background: var(--panel); border: 1px solid
var(--line-soft); border-radius: var(--radius); box-shadow: var(--shadow)`.
- **Un solo panel oscuro por app**: el hero del dashboard (`.heroPanel`).
  Contiene el dato por el que existe el producto; nada más compite con él.
- El footer de persistencia es una línea de texto muted **sin cromo de
  tarjeta** — estado, no contenido.
- Separadores internos de tarjeta: `--hairline`. Bordes de formulario:
  `--line-strong` (accesibilidad).
- La cuadrícula del fondo existe pero a ~50 % de la opacidad original: textura,
  no ruido.

## 4. Color con intención

- **Verde/rojo = solo movimiento**: deltas, P/L, banners de resultado. Un valor
  estático (total de capa, valor de activo) va en tinta; solo un neto negativo
  va en rojo. No usar verde para totales "buenos".
- Interacción (links de acción, hover de botón) = `--blue`.
- Capas de liquidez = familia `--tier-*`: caja/mercado en verdes (familia
  "líquido"), jubilación/ilíquido en azules (familia "resto"), vivienda en oro.
  Coinciden con los colores de la descomposición (líquido verde, vivienda oro,
  resto azul). Estos tokens alimentan donut, filas, barras, drill-downs y
  sparklines — cambiar uno los cambia todos.

## 5. Componentes

- **Botones**: primario = tinta sobre panel, radio `--radius-sm`, peso 650,
  sentence case. Secundario = outline píldora (`.refreshRow button`,
  `.btnSmall`, `.actionLink`). Nunca un botón a ancho completo para una acción
  secundaria.
- **Píldoras de navegación**: nav superior, tabs de scope y Vista son píldoras
  (`border-radius: 999px`); la activa invierte a tinta. Sobre el panel oscuro,
  la Vista es un segmented control translúcido (`.heroPanel .framingTabs`).
- **Chips de delta** (`.deltaChip`): píldora con flecha ▲/▼, importe con signo,
  porcentaje y periodo ("▲ +852 € (+3,4 %) vs cierre mensual"). El % siempre
  que la base no sea cero.
- **Stats del hero** (`.heroStats`): 4-up con separadores verticales hairline,
  label uppercase pequeño + cifra. En móvil, 2×2.
- **Filas de capa** (`.tier` + `.tierBar`): `<details>` con nombre, neto, % y
  una barra embebida de 5px en el color de la capa; el desglose
  (bruto/deuda/holdings) vive dentro del details.
- **Gráficas**: SVG server-rendered con aspecto fijo (no estirar texto), ejes
  de valor (`formatCompactEur`: "25,6 k€") y fechas ("12 jun 26"), gridlines
  discontinuas al 10 %, hover con `<title>` nativo. Cierres mensuales =
  puntos grandes (`.evolutionMarker`); el resto, puntos pequeños.
- **Tablas**: cabeceras label-style, hairlines entre filas, números tabulares a
  la derecha, acciones como celda normal alineada a la derecha (**nunca**
  `display: flex` en un `<td>` — descuadra los bordes de fila).

## 6. Reglas rápidas (checklist para una página nueva)

- [ ] ¿Una sola cosa domina la página? (jerarquía de 3 niveles)
- [ ] ¿Uppercase solo en labels pequeños muted?
- [ ] ¿Números en tabular-nums, alineados a la derecha en tablas?
- [ ] ¿Verde/rojo solo si algo subió o bajó?
- [ ] ¿Tarjetas con `--panel`/`--line-soft`/`--radius`/`--shadow` y nada más?
- [ ] ¿Cero JS en cliente? (links, forms, details, title)
- [ ] ¿`--line`/`--muted` intactos o re-testeados? (`contrast.test.ts`)

## 7. Deuda conocida (siguientes pasos, no bloqueante)

- Formularios (`/inversiones/nueva`, `/patrimonio/nuevo-*`): aún con labels
  uppercase y asterisco huérfano; pendiente el flujo "búsqueda primero +
  detalles avanzados en `<details>`".
- La gráfica de descomposición no comparte márgenes con los ejes de la de
  evolución.
- Outliers del histórico (p. ej. un snapshot de 902 € en una serie de ~25 k€)
  se renderizan tal cual; su tratamiento es trabajo de dominio.
- Modo oscuro: los tokens lo dejan a un `prefers-color-scheme` de distancia.

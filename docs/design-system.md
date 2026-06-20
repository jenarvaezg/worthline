# Sistema de diseño de worthline

Guía de estilo del rediseño «mix» (junio 2026). Origen: prototipo de variantes
sobre `/` (bento / informe / denso); ganó **bento con acentos de denso** —
grid de 12 columnas con hero en tarjeta clara de tinte verde y filas de datos
densas con barras embebidas. Toda la implementación vive en tokens y clases de
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
| `--ink-panel`                            | `#1d2724`              | Token oscuro heredado; el hero ya NO lo usa (ahora es claro, §3). Se conserva para tests / futuro modo oscuro    |
| `--ink-panel-text` / `--ink-panel-muted` | `#e8ece7` / `#9fb0a9`  | Texto sobre superficie oscura (heredado; el hero ya no lo usa)                                                   |
| `--muted`                                | `#51605b`              | Texto secundario y labels (≥4.5:1 — testeado)                                                                    |
| `--line` / `--line-strong`               | `#78877f` / `#5d6c66`  | Bordes con significado: controles de formulario, separadores funcionales (≥3:1 WCAG 1.4.11 — `contrast.test.ts`) |
| `--line-soft` / `--hairline`             | `#d9ded7` / `#e4e8e2`  | Bordes decorativos: tarjetas y filas. Nunca el único límite de un control                                        |
| `--green` / `--red`                      | `#006f5f` / `#b9442f`  | **Reservados para deltas y P/L** (+ banners éxito/error); el tinte del hero deriva de `--green`                  |
| `--pos-on-dark` / `--neg-on-dark`        | `#5ad4ae` / `#f0907b`  | Deltas sobre superficie oscura (heredado; el hero usa `--green` / `--red`)                                       |
| `--blue`                                 | `#245177`              | Acento de interacción: links de acción, hover                                                                    |
| `--gold`                                 | `#b3831f`              | Avisos                                                                                                           |
| `--tier-cash`→`--tier-housing`           | verdes → azules → oro  | Identidad de capas de liquidez (ver §5)                                                                          |
| `--radius` / `--radius-sm`               | `14px` / `8px`         | Tarjetas / controles. Píldoras: `999px`                                                                          |
| `--shadow`                               | corta y suave, 2 capas | **La única elevación.** No inventar sombras nuevas                                                               |

## 2. Jerarquía tipográfica

Tres niveles — cuando todo es énfasis, nada lo es:

1. **Cifra héroe**: `clamp(2.2rem, 4.5vw, 3rem)`, peso 760, `letter-spacing
-0.02em`. Solo el patrimonio neto del dashboard.
2. **Títulos de panel** (`h2`): `1rem`, peso 650, **sentence case** — nada de
   uppercase ni letter-spacing.
3. **Labels pequeños** (stats, cabeceras de tabla, `h3`): `0.7–0.78rem`,
   uppercase con `letter-spacing` — es el ÚNICO sitio donde se permite
   uppercase, y siempre en `--muted`.

**Las cifras de valor usan la cara monoespaciada (Iosevka, `--font-mono`) con
figuras tabulares**; el texto va en sans. En tablas, las columnas numéricas se
alinean a la derecha. Formato es-ES (`formatMoneyMinor`); porcentajes con coma
decimal y signo explícito ("+3,6 %").

## 3. Superficies y elevación

- Tarjeta estándar: `background: var(--panel); border: 1px solid
var(--line-soft); border-radius: var(--radius); box-shadow: var(--shadow)`.
- **El hero es la tarjeta protagonista** (`.heroPanel`): una superficie clara
  con un tinte verde sutil (gradiente derivado de `--green`), distinguida del
  resto de tarjetas crema no por oscuridad sino por ese tinte. Contiene el dato
  por el que existe el producto; nada más compite con él. (Antes era el único
  panel oscuro; se aclaró para que dejara de leerse como una isla — ADR 0032.)
- El footer de persistencia es una línea de texto muted **sin cromo de
  tarjeta** — estado, no contenido.
- Separadores internos de tarjeta: `--hairline`. Bordes de formulario:
  `--line-strong` (accesibilidad).
- La cuadrícula del fondo existe pero a ~50 % de la opacidad original: textura,
  no ruido.

## 4. Color con intención

- **Verde/rojo = solo movimiento**: deltas, P/L, banners de resultado. Un valor
  estático (total de capa, valor de activo) va en tinta; solo un neto negativo
  va en rojo. No usar verde para totales "buenos". (El tinte verde del hero es
  superficie, no dato — no compite con esta regla.)
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
  (`border-radius: 999px`); la activa invierte a tinta. En el hero, la Vista es
  un segmented control claro (`.heroPanel .framingTabs`).
- **Chips de delta** (`.deltaChip`): píldora con flecha ▲/▼, importe con signo,
  porcentaje y periodo ("▲ +852 € (+3,4 %) vs cierre mensual"). El % siempre
  que la base no sea cero. En el hero usan la paleta clara (`--green` / `--red`).
- **Stats del hero** (`.heroStats`): 4-up como mini-tarjetas de tinte verde,
  label uppercase pequeño + cifra. En móvil, 2×2.
- **Filas de capa** (`.tier` + `.tierBar`): `<details>` con nombre, neto, % y
  una barra embebida de 5px en el color de la capa; el desglose
  (bruto/deuda/holdings) vive dentro del details.
- **Gráficas** (ADR 0032): SVG server-rendered con aspecto fijo (no estirar
  texto). La gráfica de patrimonio y sus drilldowns son **barras apiladas
  discretas** — una columna por periodo (mes, y trimestre/año en ventanas
  largas), no áreas: cada lectura es un hecho medido, no una interpolación. La
  **vivienda se muestra neta** (equity = valor − la hipoteca que la asegura) por
  defecto; «Ocultar vivienda» es estado de URL, así que sobrevive al cambio de
  rango/vista. Entrar a un drilldown es un _zoom_ a la misma gramática: el
  agregado del grupo y las sparklines por holding también son barras (con altura
  mínima de barra para que 1-2 puntos no degeneren en una rendija). Rellenos
  translúcidos en color de capa (`--tier-*`); deudas en `--red`; línea de
  patrimonio neto en `--ink` con puntos en los cierres mensuales; fechas
  "12 jun 26"; hover con tooltip.
- **Tablas**: cabeceras label-style, hairlines entre filas, números tabulares a
  la derecha, acciones como celda normal alineada a la derecha (**nunca**
  `display: flex` en un `<td>` — descuadra los bordes de fila).

## 6. Reglas rápidas (checklist para una página nueva)

- [ ] ¿Una sola cosa domina la página? (jerarquía de 3 niveles)
- [ ] ¿Uppercase solo en labels pequeños muted?
- [ ] ¿Números en la cara mono con figuras tabulares, alineados a la derecha en tablas?
- [ ] ¿Verde/rojo solo si algo subió o bajó?
- [ ] ¿Tarjetas con `--panel`/`--line-soft`/`--radius`/`--shadow` y nada más?
- [ ] ¿Gráficas en barras discretas, vivienda neta, drill como zoom de la misma gramática? (ADR 0032)
- [ ] ¿Cero JS en cliente? (links, forms, details, title)
- [ ] ¿`--line`/`--muted` intactos o re-testeados? (`contrast.test.ts`)

## 7. Deuda conocida (siguientes pasos, no bloqueante)

- Formularios (`/inversiones/nueva`, `/patrimonio/nuevo-*`): aún con labels
  uppercase y asterisco huérfano; pendiente el flujo "búsqueda primero +
  detalles avanzados en `<details>`".
- Outliers del histórico (p. ej. un snapshot de 902 € en una serie de ~25 k€)
  se renderizan tal cual; su tratamiento es trabajo de dominio.
- Los tokens `--ink-panel*` y `--*-on-dark` quedan definidos pero sin uso tras
  pasar el hero a claro (§3); candidatos a limpieza o a alimentar un futuro
  modo oscuro.
- Modo oscuro: los tokens lo dejan a un `prefers-color-scheme` de distancia.

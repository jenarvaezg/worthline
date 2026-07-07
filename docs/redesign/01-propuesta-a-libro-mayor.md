# Propuesta A — «Libro mayor»

Rediseño visual claro. Tesis: worthline es un **libro de contabilidad
doméstica bien encuadernado**. El papel verdoso de los libros contables, las
secciones regladas con tinta en lugar de tarjetas flotantes, la notación
contable real (subraya simple = subtotal, **doble subraya = total**) y la
**línea roja del "debe"** que en el papel de contabilidad separa la columna de
cargos. Todo lo que hoy es cromo (píldoras, sombras, radios) se sustituye por
estructura impresa: reglas, banding y tipografía.

Es una **evolución**: conserva el papel cálido, el verde de marca y la
jerarquía actual. Se puede desplegar página a página sin estado intermedio
feo.

Leer primero: [00-analisis-visual.md](./00-analisis-visual.md) §3
(restricciones duras). Este documento asume esas restricciones.

## 1. Tokens (`:root` de `globals.css`)

Los nombres NO cambian salvo los marcados «NUEVO». Solo cambian valores.

| Token                      | Hoy                   | Propuesta              | Nota                                                                              |
| -------------------------- | --------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `--paper`                  | `#eef2ef`             | `#eef0e4`              | Papel de libro contable: un punto más cálido y amarillo-verdoso                   |
| `--panel`                  | `#fffdf7`             | `#f7f7ee`              | Menos blanco: hoja interior, no tarjeta luminosa                                  |
| `--ink`                    | `#17201e`             | `#1c2420`              | Tinta estilográfica, apenas más azulada                                           |
| `--muted`                  | `#51605b`             | `#4e5c54`              | Re-testear 4.5:1 sobre `--paper` y `--panel`                                      |
| `--line` / `--line-strong` | `#78877f` / `#5d6c66` | sin cambio             | Bordes de control (WCAG 1.4.11)                                                   |
| `--line-soft`              | `#d9ded7`             | `#c9cfbd`              | Regla impresa verdosa: más presente porque sustituye a la sombra                  |
| `--hairline`               | `#e4e8e2`             | `#dde1d0`              | Ídem                                                                              |
| `--green` / `--red`        | sin cambio            | sin cambio             | Semántica de movimiento intacta                                                   |
| `--blue`                   | `#245177`             | `#1f4d74`              | Tinta de bolígrafo azul (interacción)                                             |
| `--gold`                   | sin cambio            | sin cambio             |                                                                                   |
| `--tier-*`                 | sin cambio            | sin cambio             |                                                                                   |
| `--radius`                 | `14px`                | `6px`                  | Un libro no tiene esquinas de app                                                 |
| `--radius-sm`              | `8px`                 | `4px`                  |                                                                                   |
| `--shadow`                 | 2 capas suaves        | `none` (ver §3)        | La elevación desaparece: esto es papel impreso                                    |
| `--rule-heavy` NUEVO       | —                     | `2px solid var(--ink)` | Regla de apertura de sección (§3)                                                 |
| `--debit-rule` NUEVO       | —                     | `#a03a28`              | La línea roja del "debe". Distinta de `--red` a propósito: es estructura, no dato |
| `--band` NUEVO             | —                     | `#eaedde`              | Banding de fila de tabla (papel contable rayado)                                  |

La cuadrícula de fondo actual se conserva pero pasa de cuadrícula a **rayado
horizontal** (solo líneas horizontales, mismo tono): papel pautado, no papel
milimetrado.

## 2. Tipografía

- **NUEVA fuente de rotulación: Bitter** (slab serif, OFL, Google Fonts).
  Descargar woff2 latin 600 y 700 a `apps/web/app/fonts/`, registrarla en
  `layout.tsx` como `--font-display`. Se usa SOLO en dos sitios:
  1. Título de página (`h1` tipo «Objetivos», «Patrimonio»): Bitter 700,
     `1.35rem`, tracking normal.
  2. Títulos de panel (`h2`): Bitter 600, `1rem`, sentence case.
     En ningún otro sitio. Ni cifras, ni labels, ni botones, ni párrafos.
- **Cifra héroe**: sigue en Iosevka, mismo clamp y peso, PERO gana la **doble
  subraya contable** (§4). Las cifras de valor siguen todas en Iosevka
  tabular; el cuerpo sigue en Source Sans 3. Sin cambios de escala.
- **Labels pequeños**: sin cambio (uppercase 0.7–0.78rem muted). Siguen
  siendo el único uppercase permitido.

Regla para el implementador: si dudas de qué fuente lleva algo, la respuesta
es «la que ya llevaba». Bitter solo entra en `h1`/`h2`.

## 3. Superficies: de tarjetas a secciones regladas

El cambio estructural de la propuesta. Hoy: `panel + line-soft + radius +
shadow` en todo. Propuesta:

- **Sección estándar** (sustituye a la tarjeta en home, /objetivos,
  /patrimonio): sin fondo propio (hereda `--paper`), sin sombra, sin borde
  perimetral. Se abre con una **regla gruesa superior** `border-top:
var(--rule-heavy)` pegada al título de panel, como los capítulos de un
  libro de cuentas. Separación entre secciones: espacio en blanco (mínimo
  `2.5rem`), no cajas.
- **El hero es la única superficie con fondo**: conserva `.heroPanel` con su
  tinte verde y gana `border: 1px solid var(--line-soft)`; radio `--radius`
  (ahora 6px), sin sombra. Es «el asiento destacado»: la única hoja
  encartada de la página. Nada más compite.
- Las mini-tarjetas de stats del hero (`.heroStats`) pierden el fondo propio
  y pasan a celdas separadas por hairlines verticales (una fila reglada).
- El footer de persistencia: sin cambio (línea muted sin cromo).

ASCII de la home resultante:

```
┌──────────────────────────────────────────────┐
│ worthline   Resumen Patrimonio Histórico ...  │  ← nav como pestañas de registro (§5)
└──────────────────────────────────────────────┘
╔══════════════════════════════════╗
║ NETO TOTAL                       ║  ← hero: única "hoja" con fondo tintado
║ 291.604 €                        ║
║ ═════════                        ║  ← doble subraya contable (signature)
║ stats │ stats │ stats │ stats    ║
╚══════════════════════════════════╝
━━━━━━━━━━━━━━━━━━━━━━                ← regla gruesa: abre sección
Qué movió tu patrimonio
  Bitcoin ............ +16.147 €
━━━━━━━━━━━━━━━━━━━━━━
Liquidez                    ┃ barras (§6)
```

## 4. Signature: notación contable real

Dos dispositivos, con significado, no decoración:

1. **Doble subraya de total** (`.totalRule`): todo TOTAL final lleva debajo
   una doble línea (`border-bottom: 3px double var(--ink)`, ancho = ancho de
   la cifra, hueco de 3px). Se aplica a: cifra héroe de la home, «Patrimonio
   neto» en la fila BALANCE de /patrimonio, y al total de cada columna
   (ACTIVOS / PASIVOS). Los **subtotales** (total de capa, total de grupo)
   llevan subraya simple (`border-bottom: 1px solid var(--ink)`). Nada más
   se subraya — resuelve además el P6: los nombres de holding PIERDEN el
   subrayado y pasan a peso 650 a secas.
2. **Línea roja del "debe"** (`.debitCol`): toda columna/lista de deudas y
   pasivos lleva a su izquierda una regla vertical `2px solid
var(--debit-rule)` continua de arriba abajo (en /patrimonio: la columna
   PASIVOS entera; en el hero: la celda «Deudas»). Las cifras de deuda
   siguen en tinta (son valores estáticos); la línea roja es quien dice
   «esto es el debe». Con esto el rojo-dato queda libre para movimiento,
   como manda la semántica.

## 5. Componentes

- **Nav superior**: de píldoras a **pestañas de registro** (como las
  pestañas laterales de un libro de contabilidad): texto en Source Sans 650,
  la activa con `border-bottom: 2px solid var(--ink)` y tinta plena; las
  inactivas en `--muted` sin borde. Sin fondos, sin radios. En móvil (P5):
  una sola fila con scroll horizontal (`overflow-x: auto`,
  `scrollbar-width: none`), nunca wrap; «Cerrar sesión» se queda como texto
  pequeño al final de la fila.
- **Tabs de scope / Vista / rangos (1A/3A/5A/Todo)**: segmented control
  rectangular radio 4px, borde `--line`, la activa invierte a tinta. Deja de
  haber píldoras 999px en toda la app (P2). Excepción única: los **chips de
  holdings** en formularios siguen siendo píldora (son tokens/etiquetas, no
  navegación).
- **Botones**: primario = tinta sobre panel, radio 4px, sin cambio de peso.
  Secundario = outline rectangular radio 4px con borde `--line-strong`.
  El «Crear objetivo» a ancho completo (P7) pasa a botón primario de ancho
  natural alineado a la derecha del formulario.
- **Formularios** (P7): inputs con fondo `--panel`, borde 1px
  `--line-strong`, radio 4px; en focus, borde `--blue` + outline visible.
  Labels como hoy.
- **Chips de delta**: mantienen forma y contenido, radio 4px en vez de
  píldora. Colores intactos.
- **Tablas** (arregla P3): cabeceras label-style como hoy; **banding**
  `--band` en filas alternas (papel rayado); números tabulares a la derecha.
  En /historico además: (a) los cierres de mes dejan de ser chip oscuro y
  pasan a **fila con banding más oscuro + cifra en peso 700 + subraya
  simple** (es un subtotal: notación de §4); (b) separador de año = regla
  gruesa `--rule-heavy` con el año como label pequeño; (c) la tabla vive en
  una sección reglada, no a ancho de página: máximo `~880px` centrada.
- **Filas de capa** (`.tier`): sin cambio estructural; la barra embebida de
  5px conserva los `--tier-*`.
- **Kebab «···»**: pierde el círculo con borde; queda el glifo en `--muted`,
  hover `--blue`.

## 6. Gráficas y donut

- **Barras apiladas** (ADR 0032 intacto): rellenos pasan de translúcido a
  **sólido plano** en el color de capa (impreso, no acuarela); trazo 0. La
  línea de patrimonio neto sigue en `--ink` con puntos en cierres. La
  rejilla de la gráfica: solo horizontales en `--hairline` (papel pautado,
  coherente con el fondo).
- **Donut de liquidez (P4)**: mismo SVG, dos cambios visuales:
  1. Vivienda (y todo tier ilíquido) se rellena con **patrón rayado**
     (`<pattern>` de líneas diagonales del propio color al ~55 %) — lo
     ilíquido se ve «no contante» a simple vista; lo líquido queda sólido.
  2. El % del bruto de cada capa se mantiene; sin otros cambios.
     El mismo patrón rayado se aplica al segmento vivienda en las barras
     apiladas y en las barras-medidor de las filas, para que la codificación
     sea una sola en toda la app.

## 7. Orden de aplicación (para el implementador)

1. Tokens de §1 en `:root` + rayado de fondo. La app queda más plana pero
   coherente: es el estado base.
2. Fuente Bitter (descarga OFL, `layout.tsx`, `--font-display`) y su
   aplicación a `h1`/`h2`.
3. Superficies §3 (secciones regladas, hero única hoja).
4. Notación contable §4 (`.totalRule`, `.debitCol`).
5. Componentes §5 en este orden: nav → tabs → botones/forms → tablas
   (/historico al final, es el mayor).
6. Gráficas y patrón rayado §6.
7. `contrast.test.ts`: añadir pares `--muted`/`--paper` nuevo,
   `--muted`/`--panel` nuevo, `--debit-rule`/`--paper` (≥3:1 como borde) y
   re-correr. Gauntlet completo.

## 8. Checklist de verificación (comparar contra capturas)

- [ ] Cero sombras en toda la app; cero radios >6px salvo chips de holding.
- [ ] Una sola superficie con fondo por página (el hero / panel estrella).
- [ ] La cifra héroe lleva doble subraya; ningún holding lleva subrayado.
- [ ] Toda lista de pasivos tiene la línea roja vertical a la izquierda.
- [ ] Bitter aparece SOLO en h1/h2.
- [ ] /historico: banding, cierres como subtotales, reglas por año, ≤880px.
- [ ] Móvil: nav en una fila con scroll, sin wrap.
- [ ] Donut y barras: vivienda rayada, líquido sólido.
- [ ] Verde/rojo siguen apareciendo únicamente en deltas/P/L/banners.
- [ ] `contrast.test.ts` verde con los pares nuevos; gauntlet verde.

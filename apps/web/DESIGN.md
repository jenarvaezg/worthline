---
name: worthline
description: Un libro mayor digital, preciso y bajo el control del usuario.
colors:
  cover: "#102420"
  cover-depth: "#0a1916"
  cover-highlight: "#16302a"
  cover-ink: "#ecefe1"
  cover-muted: "#9fb0a3"
  gilt: "#c2a14e"
  gilt-soft: "#8f7a45"
  gilt-highlight: "#cfa649"
  paper: "#eef0e4"
  panel: "#f7f7ee"
  ink: "#1c2420"
  muted: "#4e5c54"
  line: "#78877f"
  line-strong: "#5d6c66"
  line-soft: "#c9cfbd"
  hairline: "#dde1d0"
  band: "#eaedde"
  band-hover: "#e2e6d2"
  interaction: "#1f4d74"
  debit-rule: "#a03a28"
  positive: "#006f5f"
  negative: "#b9442f"
  warning: "#b3831f"
  tier-housing: "#b3831f"
  tier-cash: "#0d7a64"
  tier-market: "#2aa188"
  tier-term-locked: "#2f5e8d"
  tier-illiquid: "#6b86a3"
typography:
  cover-display:
    fontFamily: "Bitter, Rockwell, Georgia, serif"
    fontSize: "clamp(2.7rem, 5.6vw, 4.3rem)"
    fontWeight: 700
    lineHeight: 1.03
    letterSpacing: "-0.012em"
  page-title:
    fontFamily: "Bitter, Rockwell, Georgia, serif"
    fontSize: "1.35rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  section-title:
    fontFamily: "Bitter, Rockwell, Georgia, serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  numeric:
    fontFamily: "Iosevka, ui-monospace, monospace"
    fontSize: "clamp(2.2rem, 4.5vw, 3rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  label:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.1em"
rounded:
  bar: "2px"
  control: "4px"
  surface: "6px"
components:
  button-cover-primary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.cover}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.62rem 1.3rem"
  button-cover-outline:
    backgroundColor: "transparent"
    textColor: "{colors.cover-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.62rem 1.3rem"
  button-product-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.panel}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.62rem 1.3rem"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.62rem 0.75rem"
  ledger-sheet:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "1.5rem 1.7rem"
---

# Design System: worthline

## 1. Overview

**Creative North Star: "El libro mayor bien encuadernado"**

worthline se siente como un libro de contabilidad doméstica preciso y cuidado: una cubierta de tinta profunda marca los umbrales y remates; el interior de trabajo usa papel contable claro, reglas, banding y notación financiera real. Son dos registros de una sola identidad, nunca dos temas conmutables.

**Vigente — landing.** «La cubierta y las páginas» es la referencia visual ya implementada: cubierta física, hoja encartada con cifras reales, páginas pautadas y contracubierta. La personalidad es precisa, serena y soberana, con riesgo visual concentrado en la cubierta y máxima legibilidad en las páginas.

**Propuesto — producto (#906, pendiente de migración).** «Libro mayor» abre ese mismo objeto en las rutas de trabajo: elimina tarjetas flotantes, sombras y cromo de píldora en favor de secciones regladas, controles rectangulares y jerarquía contable. El sistema global heredado no es fuente para este documento; solo se preservan Iosevka tabular, la semántica de color, el contraste probado y la gramática de gráficas.

**Key Characteristics:**

- Cubierta para umbrales y remates; papel para todo trabajo.
- Una sola superficie destacada por página; el resto se estructura con reglas y espacio.
- Totales, subtotales y deudas se distinguen mediante notación contable con significado.
- Cifras visibles y completas desde el servidor; el movimiento mejora el estado final, nunca lo desbloquea.
- Densidad serena, formas contenidas y ningún adorno sin función.

## 2. Colors

La paleta combina tinta verde profunda y oro sobrio en la cubierta con papel verdoso, tinta oscura y semántica financiera estricta en el interior.

### Primary

- **Tinta de cubierta** (`cover`): superficie vigente de la landing y base de las futuras `coverSurface` y `coverMasthead` propuestas por #906.
- **Tinta estilográfica** (`ink`): texto principal, reglas contables y acciones primarias sobre papel.
- **Azul de bolígrafo** (`interaction`): enlaces, hover y foco; nunca decoración.

### Secondary

- **Oro de filete** (`gilt`): filetes, puntuación y detalles de encuadernación sobre cubierta.
- **Línea del debe** (`debit-rule`): regla estructural junto a pasivos; no colorea la cifra estática.
- **Oro de aviso** (`warning`): avisos; comparte valor con vivienda, pero no su significado.

### Tertiary

- **Verde de movimiento** (`positive`) y **rojo de movimiento** (`negative`): exclusivamente deltas, P/L y banners de resultado.
- **Familia de liquidez** (`tier-cash`, `tier-market`, `tier-term-locked`, `tier-illiquid`, `tier-housing`): codifica capas de forma estable en barras, filas, leyendas y gráficas.

### Neutral

- **Papel contable** (`paper`): fondo del trabajo interior.
- **Hoja encartada** (`panel`): superficie excepcional para el hero, formularios y hojas con una función propia.
- **Tinta secundaria** (`muted`): texto auxiliar con contraste AA.
- **Reglas de control** (`line`, `line-strong`): límites que deben ser perceptibles.
- **Reglas impresas** (`line-soft`, `hairline`): divisores y pautado que nunca son el único límite de un control.
- **Banding de libro** (`band`): alternancia de filas del producto propuesto.

Los matices `cover-depth`, `cover-highlight`, `gilt-soft`, `gilt-highlight` y `band-hover` pertenecen a la composición vigente de la landing. No se promueven por sí solos a una segunda paleta global.

### Named Rules

**The One Identity Rule.** Cubierta y papel se asignan por superficie; está prohibido un selector de tema o apariencia.

**The Movement Rule.** Verde y rojo significan que algo subió, bajó o produjo un resultado. Un valor estático permanece en tinta.

**The Illiquidity Pattern Rule.** En la landing vigente solo la vivienda usa oro rayado. En el producto propuesto, cada tier ilíquido usa un patrón rayado de su propio color; lo líquido usa relleno sólido. El color nunca es la única señal.

## 3. Typography

**Display Font:** Bitter (with Rockwell, Georgia and serif fallback)  
**Body Font:** Source Sans 3 (with system-ui and sans-serif fallback)  
**Mono Font:** Iosevka (with ui-monospace and monospace fallback)

**Character:** Bitter aporta la voz de rotulación del libro sin invadir la interfaz; Source Sans 3 mantiene lectura y controles familiares; Iosevka hace que las cifras parezcan medidas, alineadas y auditables.

### Hierarchy

- **Cover Display** (700, `clamp(2.7rem, 5.6vw, 4.3rem)`, 1.03): titular principal de la cubierta de la landing.
- **Page Title** (700, 1.35rem, 1.2): h1 de las futuras páginas de producto.
- **Section Title** (600, 1rem, 1.3): h2 que abre una sección reglada.
- **Hero Number** (700, `clamp(2.2rem, 4.5vw, 3rem)`, 1.05): única cifra dominante de una página; siempre Iosevka tabular.
- **Body** (400, 1rem, 1.55): lectura y controles, con prosa limitada a 65–75ch.
- **Label** (600, 0.72rem, 0.1em, uppercase): cabeceras, folios y labels pequeños; es el único uppercase permitido.

En la landing vigente, Bitter también articula titulares editoriales de sus secciones. En el producto propuesto por #906, Bitter se limita estrictamente a h1 y h2.

### Named Rules

**The Measured Number Rule.** Toda cifra de valor usa Iosevka con figuras tabulares; columnas numéricas se alinean a la derecha.

**The Two-Heading Rule.** En producto, si no es h1 o h2, no usa Bitter.

**The Quiet Label Rule.** Uppercase y tracking pertenecen solo a labels pequeños y reales, nunca a una ceja repetida sobre cada sección.

## 4. Elevation

El sistema es plano e impreso. No usa sombras de elevación. La profundidad procede del cambio entre cubierta y papel, de una hoja encartada excepcional, de reglas con peso distinto, del banding y del espacio vertical. Una superficie con borde no añade además una sombra decorativa.

### Named Rules

**The No Shadow Rule.** `box-shadow` de elevación y el token `--shadow` están prohibidos en el producto futuro.

**The One Sheet Rule.** Solo el hero o panel estrella puede tener fondo propio como hoja encartada; las demás agrupaciones son secciones abiertas, no tarjetas.

**The Printed Structure Rule.** Regla gruesa abre sección, hairline separa filas y doble regla cierra un total. Ninguna de ellas es adorno intercambiable.

## 5. Components

### Cover Surface — vigente en landing

- **Character:** umbral oscuro, físico y sobrio; concentra identidad antes de abrir el libro.
- **Color:** tinta de cubierta con variación tonal contenida; texto `cover-ink`, secundario `cover-muted` y filetes `gilt`.
- **Behavior:** alberga masthead, CTA, hoja encartada y contracubierta. La textura física de la landing es una excepción localizada, no un fondo reutilizable por defecto.
- **Motion:** el HTML llega completo. La coreografía progresiva puede dibujar reglas, cifras y gráficas; con movimiento reducido todo aparece final e inmediato.

### Buttons

- **Shape:** rectangular contenido (4px), ancho natural y peso 650.
- **Cover Primary — vigente:** papel sobre tinta de cubierta; hover aclara el papel.
- **Cover Outline — vigente:** transparente con texto claro y borde de cubierta perceptible.
- **Product Primary — propuesto:** tinta sobre panel.
- **Product Secondary — propuesto:** transparente, borde `line-strong`, tinta y ancho natural.
- **Focus:** outline azul visible sobre papel; outline oro visible sobre cubierta.

### Inputs / Fields — propuesto en #906

- **Style:** panel claro, borde de control `line-strong`, radio 4px.
- **Focus:** borde azul más outline visible.
- **Error / Disabled:** error comunicado con texto y estado además del color; el disabled conserva legibilidad.
- **Labels:** lenguaje y longitud preparados para internacionalización; ningún asterisco queda aislado.

### Navigation — propuesto en #906

- **Nav Tab:** pestaña de registro sin fondo ni radio; activa con tinta plena y regla inferior de 2px, inactiva en tinta secundaria.
- **Mobile:** una sola fila con scroll horizontal y sin scrollbar visible; nunca wrap.
- **Segmented:** rectángulo de 4px con borde `line`; la selección invierte a tinta. Las píldoras quedan reservadas para chips de holding.

### Ruled Section — propuesto en #906

- **Character:** capítulo abierto del libro.
- **Structure:** sin fondo, sombra ni borde perimetral; regla superior de 2px pegada al h2 y un mínimo de 2.5rem entre secciones.
- **Use:** sustituye las tarjetas repetidas en resumen, objetivos y patrimonio.

### Hero Panel / Ledger Sheet

- **Vigente — landing:** hoja encartada con datos demo reales, fondo panel, borde suave, radio 6px, pautado horizontal, filas con banding y cifras tabulares.
- **Propuesto — producto:** única superficie con fondo por página; tinte verde sutil, borde suave, radio 6px y cero sombra.
- **Stats:** celdas separadas por hairlines, no mini-tarjetas.

### Accounting Signatures — vigente y propuesto

- **Final Total — vigente landing:** dos reglas de 1px con hueco, bajo la cifra y exactamente su ancho.
- **Final Total — propuesto producto:** borde doble de 3px bajo la cifra final.
- **Subtotal — propuesto producto:** una sola regla bajo el valor.
- **Debit Column — vigente y propuesto:** regla continua de 2px en `debit-rule` a la izquierda de pasivos; la cifra permanece en tinta.
- **Band — vigente landing:** filas alternas en `band`, con `band-hover` local al pasar el puntero.
- **Band — propuesto producto:** filas alternas en `band`; el tratamiento de hover no promueve `band-hover` al canon global.
- **Charts:** barras discretas y sólidas; rejilla solo horizontal; vivienda rayada y líquido sólido.

### Canonical Class Contract — propuesto, pendiente de #906

`.section`, `.heroPanel`, `.navTab`, `.segmented`, `.btn`, `.totalRule`, `.debitCol`, `.band`, `.coverSurface`, `.coverMasthead` y la banda de sesión forman el futuro catálogo compartido. Hasta que la migración aterrice, este contrato describe el destino; no autoriza a tratar el `globals.css` heredado como implementación terminada.

## 6. Do's and Don'ts

### Do:

- **Do** distinguir siempre entre **Vigente — landing** y **Propuesto — producto (#906, pendiente de migración)**.
- **Do** usar cubierta en umbrales y remates, y papel en todas las superficies de trabajo.
- **Do** hacer explicable cada cifra mediante jerarquía, desglose, fuente y notación contable.
- **Do** renderizar el contenido completo antes de cualquier mejora de movimiento y respetar `prefers-reduced-motion`.
- **Do** mantener contraste WCAG 2.2 AA, foco visible, teclado completo y significado redundante al color.
- **Do** diseñar labels, controles y composiciones para traducciones más largas.
- **Do** conservar la semántica de color y la gramática de gráficas al migrar; #906 no cambia información, rutas, cálculos ni interacción.

### Don't:

- **Don't** importar el sistema heredado de tarjetas crema, radios de 14px, sombras suaves y navegación en píldoras.
- **Don't** usar sombras de elevación, radios mayores de 6px o radio 999px salvo chips de holding.
- **Don't** crear un segundo tema, modo oscuro o selector de apariencia.
- **Don't** usar verde o rojo para valores estáticos; la deuda se expresa con la Línea del debe.
- **Don't** convertir la textura física, folios, números de asiento o labels editoriales de la landing en scaffold universal.
- **Don't** usar una estética de **neobanco aspiracional**, **terminal cripto**, **clon literal de una hoja de cálculo** o **aplicación de presupuesto doméstico con gamificación**.
- **Don't** usar tarjetas idénticas para estructurar todo, subrayar nombres de holdings como si fueran enlaces ni repetir cejas uppercase sobre cada sección.
- **Don't** documentar «Panel de instrumentos», la alternativa oscura descartada, como parte del sistema.

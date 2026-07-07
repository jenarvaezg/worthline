# Análisis visual y brief de rediseño (julio 2026)

Auditoría visual de la web hosted (worthline-web.vercel.app, capturas de
2026-07-06: home desktop/móvil, /patrimonio, /historico, /objetivos) hecha
sobre el sistema actual (`docs/design-system.md`, tokens en
`apps/web/app/globals.css`). De aquí salen dos propuestas de rediseño **solo
visual** — no cambian layout de información, rutas, ni lógica:

- [01 — Propuesta A: «Libro mayor»](./01-propuesta-a-libro-mayor.md) (clara, editorial-contable, evolución)
- [02 — Propuesta B: «Panel de instrumentos»](./02-propuesta-b-panel-instrumentos.md) (oscura, instrumento de medida, inversión)

Ambas están escritas para que un modelo pequeño pueda ejecutarlas sin
interpretar: tablas de tokens viejo→nuevo, recetas por componente, orden de
aplicación y checklist de verificación.

## 1. Qué funciona hoy (conservar en cualquier propuesta)

- **Jerarquía de 3 niveles** (cifra héroe / títulos de panel / labels
  uppercase muted). Cuando se respeta, la home se lee de un vistazo.
- **Iosevka para toda cifra de valor** con figuras tabulares. Es la seña de
  identidad más fuerte del producto: los números parecen medidos, no
  decorados.
- **Disciplina semántica de color**: verde/rojo solo para movimiento (deltas,
  P/L); familias `--tier-*` para capas de liquidez, coherentes entre donut,
  filas, barras y sparklines.
- **Gramática de gráficas** (ADR 0032): barras apiladas discretas, vivienda
  neta por defecto, drill-down como zoom de la misma gramática.
- Contraste testeado (`contrast.test.ts`) y cero dependencia de color como
  único canal.

## 2. Problemas visuales observados (con página donde se ve)

| #   | Problema                                                                                                                                                                                                                                       | Dónde se ve      | Gravedad |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| P1  | **Monotonía bento**: toda superficie es tarjeta crema + radio 14px + la misma sombra. Nada tiene textura ni peso distinto; el ojo no encuentra "capítulos", solo rejilla. El conjunto cae cerca del _look_ IA-genérico "crema cálida + acento" | Home, /objetivos | Alta     |
| P2  | **Exceso de cromo píldora**: nav, tabs de scope, Vista, rangos (1A/3A/5A/Todo), botones outline, chips de holdings… todo es píldora. En /patrimonio la cabecera tiene 5 píldoras-botón + 3 píldoras-tab seguidas                               | Todas            | Alta     |
| P3  | **/historico sin diseño**: tabla cruda de ~230 filas a ancho completo, cientos de chips oscuros «CIERRE DE MES» repetidos que pesan más que los datos. Sin agrupación visual por año, sin resumen                                              | /historico       | Alta     |
| P4  | **Donut poco informativo**: con vivienda al 91 % el anillo es un bloque oro con esquirlas. El color no distingue líquido de ilíquido a simple vista                                                                                            | Home             | Media    |
| P5  | **Móvil: nav envuelve en 3 filas** de píldoras + botón «Cerrar sesión», ~180px de cromo antes del contenido                                                                                                                                    | Home móvil       | Alta     |
| P6  | **Subrayado = ¿link?**: en /patrimonio cada nombre de holding va subrayado con trazo grueso; compite con las barras-medidor de cada fila y satura la columna                                                                                   | /patrimonio      | Media    |
| P7  | **Formularios pálidos**: inputs con fondo rosado-crema y borde tenue; el botón «Crear objetivo» es un bloque negro a ancho completo que pesa más que el hero de la página                                                                      | /objetivos       | Media    |
| P8  | **Sombra + borde + radio en todo**: la elevación no significa nada porque todo está igual de elevado                                                                                                                                           | Todas            | Media    |

## 3. Restricciones duras (aplican a las dos propuestas — NO TOCAR)

1. **Solo visual**: mismos layouts de información, mismas rutas, mismos
   componentes servidor. Se cambian tokens, tipografía, bordes, fondos,
   radios, sombras y micro-detalles de componente.
2. **Semántica de color intacta**: verde/rojo = solo movimiento; `--tier-*`
   sigue alimentando donut/filas/barras/sparklines; oro = avisos y vivienda.
3. **ADR 0032**: barras discretas, SVG server-rendered, aspecto fijo. Las
   propuestas re-estilizan relleno/trazo/rejilla, no la gramática.
4. **Tipografía de cifras**: Iosevka con figuras tabulares no se negocia.
   Formato es-ES (`formatMoneyMinor`), coma decimal, signo explícito.
5. **Fuentes self-hosted OFL** (PWA offline, ver `apps/web/app/layout.tsx`):
   cualquier fuente nueva se descarga como woff2 latin subset a
   `apps/web/app/fonts/` con su licencia.
6. **Accesibilidad**: texto ≥4.5:1, bordes de control ≥3:1 (WCAG 1.4.11).
   Todo par nuevo fondo/texto se añade a `contrast.test.ts` antes de dar por
   buena la propuesta.
7. **Interacción**: `docs/interaction-patterns.md` (RSC-first) no cambia.
8. Gate completo antes de commit: tests + build + `npm run format`.

## 4. Las dos direcciones, en una frase cada una

- **A — «Libro mayor»** (clara): worthline como libro de contabilidad
  doméstica bien encuadernado — papel verdoso de libro contable, secciones
  regladas en vez de tarjetas, serif de rotulación para títulos, la doble
  subraya contable bajo los totales y la línea roja del "debe" junto a toda
  deuda. Evolución: conserva la calidez y el verde actuales, elimina el cromo.
- **B — «Panel de instrumentos»** (oscura): worthline como instrumento de
  medida — superficies verde-carbón profundas (los tokens oscuros hoy
  huérfanos: `--ink-panel`, `--pos-on-dark`, `--neg-on-dark`), Iosevka como
  protagonista absoluta, retícula de osciloscopio en las gráficas y una
  escala graduada bajo la cifra héroe. Inversión: mismo ADN, polaridad
  opuesta.

Las dos resuelven P1–P8; difieren en temperatura y en riesgo. A es segura y
despliega por partes; B es más memorable y exige pasar toda página por el
tema oscuro de una vez (no hay estado intermedio digno).

## 5. Cómo ejecutar una propuesta (para el modelo que implemente)

1. Leer la propuesta elegida entera antes de tocar nada.
2. Aplicar la tabla «Tokens» en `:root` de `globals.css` (es un
   search-and-replace de valores; los NOMBRES de token no cambian salvo los
   marcados como nuevos).
3. Aplicar las recetas de componente en el orden listado (van de global a
   particular).
4. Correr `contrast.test.ts` actualizado con los pares nuevos; luego el
   gauntlet completo (tests + build + format).
5. Comparar con las capturas por página usando la checklist final de la
   propuesta; cualquier desviación se corrige, no se documenta.

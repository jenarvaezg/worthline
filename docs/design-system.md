# Sistema de diseño de worthline

Canon de la migración «Libro mayor» (julio de 2026). La dirección visual es
**un libro mayor bien encuadernado**: la cubierta marca umbrales y remates; el
papel contiene todo el trabajo. Son registros de una sola identidad, no temas
conmutables.

La fuente única de verdad ejecutable vive en `apps/web/app/globals.css`. Esta
guía explica su intención; `design-system-guardian.test.ts` blinda los valores,
las recetas y las prohibiciones. El reparto RSC/cliente y los estados de URL
siguen en [`interaction-patterns.md`](./interaction-patterns.md).

## 1. Tokens canónicos

| Rol | Token | Valor |
| --- | --- | --- |
| Cubierta | `--cover` / `--cover-2` / `--cover-3` | `#102420` / `#0a1916` / `#16302a` |
| Tinta de cubierta | `--cover-ink` / `--cover-muted` | `#ecefe1` / `#9fb0a3` |
| Filete | `--gilt` | `#c2a14e` |
| Papel / hoja | `--paper` / `--panel` | `#eef0e4` / `#f7f7ee` |
| Tinta | `--ink` / `--muted` | `#1c2420` / `#4e5c54` |
| Reglas funcionales | `--line` / `--line-strong` | `#78877f` / `#5d6c66` |
| Reglas impresas | `--line-soft` / `--hairline` | `#c9cfbd` / `#dde1d0` |
| Banding | `--band` | `#eaedde` |
| Interacción | `--blue` | `#1f4d74` |
| Movimiento | `--green` / `--red` | `#006f5f` / `#b9442f` |
| Aviso / debe | `--gold` / `--debit-rule` | `#7d5c12` / `#a03a28` |
| Forma | `--radius` / `--radius-sm` | `6px` / `4px` |
| Regla de sección | `--rule-heavy` | `2px solid var(--ink)` |

Los tokens `--tier-*` mantienen la identidad de las capas de liquidez: verdes
para líquido, azules para el resto y oro para vivienda. `--shadow`,
`--ink-panel*` y `--pos/neg-on-dark` están borrados y no deben reaparecer.

## 2. Cubierta y papel

- **Cubierta**: login, selector demo, 404, footer/remates y la landing. Usa
  `.coverSurface`; esta receta remapea localmente papel, tinta y muted a
  `--cover*` y lleva el grano de papel del canon. No crea un tema ni un
  selector de apariencia. Una hoja luminosa encartada dentro de una cubierta
  (el panel del login, las tarjetas de persona) usa `.coverSheet`, que
  restaura los tokens de papel que la cubierta sombrea.
- **Híbrido**: onboarding usa `.coverMasthead` sobre cuerpo de papel.
- **Papel**: Resumen, histórico, patrimonio, objetivos, ajustes, admin,
  asistente y errores recuperables.
- **Banda de sesión**: demo e impersonación usan `.sessionBand` y semántica de
  aviso; no se disfrazan de cubierta.

La textura física (el grano) pertenece al registro de cubierta — la landing y
las superficies `.coverSurface`. El papel de trabajo es plano; no lleva
cuadrícula decorativa global.

## 3. Tipografía

- **Bitter** (`--font-display`): h1 y h2 del producto. Las superficies de
  cubierta pueden ampliar su uso para wordmark, marginalia y composición
  editorial.
- **Source Sans 3** (`--font-body`): cuerpo, controles, navegación, h3 y el
  `.brandName` del shell.
- **Iosevka** (`--font-numeric`): cifras de valor y columnas numéricas, siempre
  con figuras tabulares.

En producto, si no es h1 o h2, no usa Bitter. Uppercase con tracking pertenece
solo a labels pequeños reales (cabeceras, stats, folios), nunca a una ceja
repetida. La cifra hero es la única cifra dominante de la página.

## 4. Estructura impresa, no elevación

El sistema no usa sombras de elevación. La jerarquía nace de reglas, banding,
espacio y del contraste entre cubierta y papel.

- `.section`: sección abierta, sin fondo ni borde perimetral; regla superior de
  2px y espacio propio.
- `.heroPanel`: única hoja con fondo por página; panel claro de radio 6px, borde
  suave y pautado horizontal. En Resumen conserva la composición 8/4 y la hoja
  con margen.
- `.totalRule`: dos reglas reales de 1px separadas por 2px. No usar
  `border-style: double`: a 1× se funde y pierde la firma contable.
- `.debitCol`: regla continua de 2px junto a un pasivo; la cifra estática sigue
  en tinta.
- `.band`: alternancia de filas. Las barras líquidas son planas; vivienda usa
  tramado además del color.

Solo los chips de selección de holding y las figuras intrínsecamente circulares
conservan forma de píldora/círculo. Tarjetas, botones, tabs, badges y barras no
usan `999px` por inercia.

El asistente (#911) no tiene ruta propia y la propuesta A no lo receta, así que
lleva receta de panel propia: una hoja encartada sobre la página (`.assistantPanel`,
fondo `--panel`) ligada por su lomo —una regla gruesa, no un borde suave con
sombra—; su masthead se abre por regla gruesa; su lanzador es un marcador
rectangular, no un círculo flotante. Sus propuestas y la lectura de adjuntos son
entradas de papel abiertas por regla gruesa (`border-top: var(--rule-heavy)`), no
tarjetas; el turno del usuario se anota con marginalia, no como burbuja de chat.

## 5. Controles y navegación

- `.navTab`: pestaña de registro sin fondo ni radio; activa mediante regla
  inferior. En móvil permanece en una fila con scroll horizontal.
- `.segmented`: rectángulo de 4px con borde perceptible; la selección invierte
  a tinta.
- `.btn`: ancho natural, radio 4px y peso 650. Primario = tinta sobre hoja;
  secundario = transparente con `--line-strong`.
- Foco visible azul sobre papel y dorado sobre cubierta. Todos los controles
  mantienen teclado, ARIA y estados hover/active/disabled/pending.

El shell se migra en su slice propia (#910). Definir `.navTab` en el cimiento no
autoriza a adelantar esa migración.

## 6. Color y gráficas

- Verde/rojo significan movimiento o resultado. Un total estático permanece en
  tinta; la deuda se identifica con la Línea del debe.
- Azul significa interacción y foco, no decoración.
- La vivienda se muestra neta y tramada; lo líquido usa relleno sólido. El
  patrón hace que el significado no dependa solo del color.
- Las series son barras discretas server-rendered; drilldowns y sparklines
  conservan la misma gramática. La matemática sigue en `packages/domain`.

## 7. Catálogo compartido

El contrato global está formado por:

`.section`, `.heroPanel`, `.navTab`, `.segmented`, `.btn`, `.totalRule`,
`.debitCol`, `.band`, `.coverSurface`, `.coverSheet`, `.coverMasthead` y
`.sessionBand`.

Las páginas consumen estas recetas; no duplican una versión equivalente ad hoc.
El test-guardián escanea todas las hojas CSS y falla ante tokens deprecados,
elevaciones, píldoras indiscriminadas, segundo tema o pérdida del catálogo. La
deuda temporal solo puede entrar con allowlist literal por archivo, selector,
propiedad y valor; nunca con un contador o un `skip`.

## 8. Checklist de una superficie

- [ ] ¿Hay una sola hoja destacada y el resto son secciones abiertas?
- [ ] ¿h1/h2 usan Bitter y el resto Source Sans 3?
- [ ] ¿Las cifras usan Iosevka tabular y se alinean a la derecha?
- [ ] ¿El total final tiene dos reglas de 1px visibles a 1×?
- [ ] ¿Pasivos, banding y vivienda usan su notación semántica?
- [ ] ¿No hay sombras, radios heredados ni `999px` accidental?
- [ ] ¿El color conserva contraste AA y nunca es la única señal?
- [ ] ¿Las interacciones preservan RSC-first, URL, Atrás, foco y movimiento reducido?

## 9. Deuda acotada durante la rama larga

Los prototipos `patrimonio/prototipo-extracto` y
`patrimonio/prototipo-deuda-estado` conservan temporalmente recetas heredadas
exactas, nominadas en el allowlist del guardián. No son precedente para código
nuevo y deben desaparecer o migrarse en el slice que retire esos prototipos.

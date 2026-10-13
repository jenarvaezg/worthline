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
| Tinte de confirmación | `--green-tint` | `rgba(0, 111, 95, 0.1)` |
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

Un chip de selección (`.chipChoice`) dice si está marcado con una **marca binaria
dibujada**, no solo con el tinte (#1483): cada `label` lleva su `.chipMark`
—casilla de 14 px cuyo ✓ existe únicamente estando marcada, dibujado por el canon,
nunca impreso y escondido con `color: transparent`, que en alto contraste lo
devolvería justo al revés— además del tinte verde. En una pantalla de teléfono con
luz, tinte contra tinte es una comparación, no una lectura: dos lectores seguidos
tomaron una lista de candidatos SIN marcar por una lista de hechos. Los marcados
salen **primero**, en orden decidido en el servidor, para que tres marcados no se
ahoguen bajo doce sin marcar. El chip es del canon, no de un uso: lo pinta el
componente compartido `chip-choice.tsx`, y el guardián prohíbe que ningún otro
`.tsx` escriba markup `.chipChoice` propio. Y el encabezado de un selector
**pregunta** («Elige qué activos…»); afirmar («Activos que…») queda para la prosa
que solo enumera lo ya marcado.

El selector **escala solo** (#1837): hasta doce opciones, chips; a partir de la
decimotercera, ochenta chips son un muro que se escanea en vez de leerse, y el mismo
componente pinta el **libro** (`.chipLedger`, isla `chip-ledger.tsx`, lógica pura en
`chip-ledger-view.ts`). Ningún consumidor elige modo; el guardián fija que solo
`chip-choice.tsx` monta el libro. El libro es:

- **Buscador primero**, pegado arriba. Filtra por nombre, ISIN/código DGS y símbolo,
  sin mayúsculas ni tildes, y resalta la coincidencia. La pista de una sola línea
  dice qué añadiría Enter (con el código si es gemelo) y esa fila sale señalada con
  banda, no marcada. Enter añade y limpia, **nunca envía** el formulario; Escape
  limpia; ↓ baja a la primera fila visible.
- **Filas por peldaño** de la escalera, cada grupo con su cabecera pegajosa (label,
  «N elegidos», recuento): casilla nativa · nombre · valor en cifra tabular,
  enmascarado en modo privacidad. Dentro del grupo, de mayor a menor valor, decidido
  en el servidor. Cada grupo enseña sus **cinco mayores** y el resto a demanda; una
  fila marcada al cargar o tocada en la sesión no se esconde al plegar —la lista no se
  mueve bajo el dedo—. Ilíquido y Vivienda salen plegados.
- **La cesta**: en escritorio (≥ 960 px), un panel pegajoso a la derecha abierto por regla gruesa a la altura de la del
  libro, con las filas del libro y su ×; en el móvil, chips con × encima del buscador
  —la única píldora del libro, porque sigue siendo un chip de selección de holding—.
  Es un espejo sin casillas.

Las casillas del libro son lo único que se envía (`defaultChecked`, el mismo `name`
que los chips): una fila oculta por el buscador, la ventana o el pliegue sigue
montada y sigue viajando en el formulario. La isla no es dueña de lo que se envía:
añade buscador, pliegue y cesta sobre casillas que ya pintó el servidor. Y en ambos
modos, dos opciones con el mismo nombre visible llevan cada
una su ISIN o código DGS (o el símbolo, si no tiene identificador) en una etiqueta
de cifra (`.chipCode` / `.chipLedgerCode`).

El asistente (#911) no tiene ruta propia y la propuesta A no lo receta, así que
lleva receta de panel propia: una hoja encartada sobre la página (`.assistantPanel`,
fondo `--panel`) ligada por su lomo —una regla gruesa, no un borde suave con
sombra—; su masthead se abre por regla gruesa; su lanzador es un marcador
rectangular, no un círculo flotante. Sus propuestas, la lectura de adjuntos y el
aviso con el que la app desmiente una propuesta que nunca llegó a existir —inventada
por el modelo (#1262), o pedida a worthline sin que devolviera tarjeta (#1468)—
son entradas de papel abiertas por regla gruesa (`border-top: var(--rule-heavy)`),
no tarjetas; el turno del usuario se anota con marginalia, no como burbuja de chat.
Cuando una propuesta nace de evidencia que worthline no ha podido validar, su
marca de procedencia (#1257) no abre una entrada nueva: el envoltorio
`.assistantProposalOrigin` se queda con la regla gruesa y el sello pasa a ser la
primera línea impresa de la MISMA entrada, en oro y nombrado con palabras.

La ficha de un activo con pestañas (#1826) reutiliza esa receta para su panel lateral
(`.fichaPanel`): una hoja encartada a la derecha, ligada por su lomo con regla gruesa,
que se superpone sin recolocar la página y empieza bajo la barra de navegación mientras
esta se ve; en el teléfono ocupa la pantalla, con su cabecera fija. Una acción cada vez.
Su cabecera de estado (`.fichaHero`) es la `.heroPanel` de la página —la única hoja
destacada—; las pestañas son `.navTab` con el recuento en gris, y la acción cuyo panel
está abierto se marca con contorno de tinta, nunca con el azul del foco.

Lo que hay bajo las pestañas son secciones abiertas, nunca otra hoja (#1830). La
pestaña Rentabilidad enfrenta dos lados bajo una misma regla gruesa partida por un
filete: «Tu dinero (TIR)» y «El fondo (TWR)», cada uno abierto por su cifra (menor que
el valor de la cabecera) y seguido de líneas de libro, con rótulo a la izquierda y
cifra tabular a la derecha. La comparación con el índice va en el lado de la TWR,
bajo un filete y no como tarjeta. Una medida que falta dice por qué. Un registro vacío
es una línea con su enlace, no un bloque de ceros.

Cuando la barra de acciones sale de la pantalla (#1829), la ficha conserva su acción
habitual en una franja fija (`.fichaStrip`): en escritorio es su cabecera condensada
—nombre, valor, el primario y «Más»— sobre su misma columna y bajo el riel de ámbitos,
cerrada por regla gruesa y sin sombra; en el teléfono es un solo botón abajo, a la
izquierda del lanzador del asistente y a su altura. Se aparta mientras hay un panel
abierto. La fila que un registro acaba de añadir lleva el tinte del aviso de éxito y la
palabra «nueva» («nuevo» en un cobro, `.fichaFreshMark`): el tinte solo no es una lectura.

Dentro de una propuesta, elegir el destino de una fila (#1373) no es un commit: son
alternativas, y llevan `.assistantRowChoice` —radios nativos con marca de selección
de regla lateral y hoja fuerte, el registro de los chips de selección de holding—
nunca relleno primario, que es el peso reservado al único primario de la tarjeta
(Confirmar). Quitar una fila del lote es un control de texto (`.assistantRowAside`),
y no comparte etiqueta con descartar la propuesta entera.

## 5. Controles y navegación

- `.navTab`: pestaña de registro sin fondo ni radio; activa mediante regla
  inferior. En móvil permanece en una fila con scroll horizontal.
- La tira de secciones del shell (`.topbarEnd`): hasta 900 px baja a su propia
  fila bajo la marca, y se desplaza con la barra oculta. El borde que esconde algo
  se desvanece (#1723): una máscara de 32 px en el lado que oculta contenido, en
  los dos si oculta en ambos, y ninguna si todo cabe. Sin sombra, sin glifos y sin
  botones de desplazamiento. Las pestañas de la ficha (`.fichaTabs`) usan la
  misma tira sin esa señal todavía.
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

**Control de texto.** Una acción secundaria dentro de una línea —«Quitar» de un
lote, el aparte de una fila de propuesta, «Indicar símbolo» y «Cotiza a mano» bajo
un precio— no es un botón de papel: sin fondo, sin borde, sin alto mínimo, sin
relleno y subrayado. Es UNA regla de `globals.css` (bajo «Control de texto») cuya
lista de selectores nombra cada superficie que la usa; cada superficie añade solo su
tono, su cuerpo y su hover en una regla propia. Una superficie nueva se suma a esa
lista, no copia las cinco declaraciones (lo fija el test-guardián).

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

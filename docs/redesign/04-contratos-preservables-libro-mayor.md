# Contratos preservables de «Libro mayor»

## Alcance y criterio

Este documento audita los contratos que una migración **solo visual** debe
conservar. «Libro mayor» puede reorganizar jerarquía, composición, densidad y
acabado; no autoriza cambiar datos, cálculos, rutas, parámetros de URL,
mutaciones ni el comportamiento de los controles. Tampoco es una propuesta de
implementación.

Se usa **obligatorio** para un resultado que debe mantenerse y **restricción**
para el límite que impide resolverlo cambiando producto o arquitectura. Las
fuentes enlazadas son locales y las pruebas citadas son la cobertura existente,
no requisitos nuevos.

## 1. Semántica visual y de color

### Obligatorio

- Conservar los tokens como semántica, no como una paleta intercambiable: verde
  y rojo expresan exclusivamente variación, P/L o resultado; azul expresa
  interacción; oro expresa avisos; y `--tier-*` identifica las capas de
  liquidez de forma consistente en donut, filas, barras, drilldowns y
  sparklines. Un total estático sigue siendo tinta, incluso si es positivo.
  El contrato completo está en el [sistema de diseño](../design-system.md).
- Mantener la jerarquía financiera: un solo dato domina (el patrimonio neto),
  cifras con tipografía monoespaciada/tabular y, en tablas, alineadas a la
  derecha; labels pequeños en muted y uppercase son la excepción, no el estilo
  de los campos de formulario. Véanse [la jerarquía tipográfica](../design-system.md)
  y el [contrato de labels](../../apps/web/app/form-label-style.test.ts).
- Mantener el contraste estructural: `--line` y `--line-strong` alcanzan 3:1
  sobre ambos papeles; `--muted`, 4.5:1; y `--line-strong` conserva una jerarquía
  visual más oscura que `--line`. Los bordes suaves solo decoran: no pueden ser
  el único límite de un control.
- Respetar superficies y elevación del sistema: panel crema, borde suave, radios
  compartidos y la única sombra definida; el hero es una superficie clara con
  tinte verde, no una tarjeta oscura aislada. No se inventan sombras ni nuevos
  significados cromáticos.

### Mandatos y pruebas que lo cubren

- El [sistema de diseño](../design-system.md) es el mandato de tokens,
  jerarquía, superficies y componentes; los valores efectivos viven en
  [`globals.css`](../../apps/web/app/globals.css).
- [`contrast.test.ts`](../../apps/web/app/contrast.test.ts) calcula y exige los
  tres umbrales WCAG y la jerarquía de los bordes. [`form-label-style.test.ts`](../../apps/web/app/form-label-style.test.ts)
  exige que `stackForm` y `ownershipGrid` compartan regla de selector y que sus
  labels no usen `uppercase`, `0.74rem` ni peso `800`.
- [`motion-tokens.test.ts`](../../apps/web/app/motion-tokens.test.ts) exige los
  seis tokens raíz `--dur-fast`, `--dur-base`, `--dur-spin`, `--dur-shimmer`,
  `--ease-out` y `--ease-in`; en declaraciones de transición o animación rechaza
  el conjunto cerrado `120ms`, `140ms`, `150ms`, `200ms`, `0.12s`, `0.15s`,
  `0.6s` y `1.4s`.

### Restricciones

- No se puede usar color para recodificar salud, categoría, importancia o datos
  estáticos que hoy tienen otro significado. La migración puede redistribuir los
  elementos, pero no cambiar lo que comunica cada color.
- No se puede degradar contraste, foco o legibilidad para conseguir una estética
  más tenue; si cambia un token estructural, conserva los umbrales probados.

## 2. Gráficas: significado, gramática y procedencia

### Obligatorio

- La gráfica de patrimonio conserva cinco bandas sobre cero, deuda bajo cero y
  la línea de patrimonio neto. En el modo por defecto `net`, Vivienda representa
  equity (valor de la propiedad menos su deuda garantizada) y esa hipoteca no
  aparece de nuevo en la pila negativa; el resultado sigue reconciliando el
  patrimonio neto. La serie muestra cierres medidos, incluido el periodo abierto
  más reciente, no una tendencia inventada.
- La gramática es de **barras apiladas discretas**, una columna por periodo; no
  áreas interpoladas. En rangos largos se mantiene el bucketing mes/trimestre/año
  y los drilldowns son un zoom de la misma gramática de barras, con altura mínima
  cuando hay pocos puntos.
- Vivienda se muestra neta por defecto: la banda es equity y la hipoteca que la
  garantiza se pliega fuera de la pila negativa. `vivienda=oculta` elimina ambos
  de lo mostrado y recalcula la línea neta; por tanto no conserva la línea del
  modo completo. Solo `gross` y `net` conservan una línea neta idéntica. El
  control sigue siendo estado enlazable `vivienda=oculta`.
- La geometría financiera sigue siendo una función pura y probada de
  [`packages/domain`](../../packages/domain/src/composition-chart.ts), y el
  resultado se renderiza como SVG. La interacción de cursor puede envolver el
  SVG, pero no sustituye geometría, datos ni semántica por una librería de
  gráficas.
- Tooltip, leyenda y anclas de drill preservan toda la información de un periodo:
  bandas, deuda cuando existe y total neto; los enlaces continúan representando
  sus destinos de drill.

### Mandatos y pruebas que lo cubren

- [ADR 0009](../adr/0009-server-rendered-svg-charts.md) fija SVG
  server-rendered, geometría pura y probada, enlaces/estado URL para la
  navegación y la ecuación de la composición. [ADR 0032](../adr/0032-discrete-bar-charts-show-housing-net.md)
  fija las barras discretas, vivienda neta y el drill como zoom.
- [`composition-chart.test.ts`](../../packages/domain/src/composition-chart.test.ts)
  cubre partición de las cinco bandas, reconciliación, barras, vivienda neta u
  oculta —incluida la igualdad de línea solo entre `gross` y `net` y el recálculo
  al ocultarla—, anchors de hover, rangos y densidad temporal. [`composition-chart.test.tsx`](../../apps/web/app/composition-chart.test.tsx)
  cubre el markup SVG, enlaces de bandas/deudas y el toggle de vivienda;
  [`composition-chart-hover.test.ts`](../../apps/web/app/composition-chart-hover.test.ts)
  cubre el tooltip consolidado.
- Los recorridos [de drill líquido](../../e2e/11-liquid-drilldown.spec.ts),
  [de deudas](../../e2e/25-debts-drilldown.spec.ts) y [de rango](../../e2e/26-composition-range.spec.ts)
  comprueban la gráfica o su estado vacío, los destinos de drill y la preservación
  de rango al volver.

### Restricciones

- No se cambian bandas, signo de deuda, cálculo, granularidad, valores de tooltip
  ni la relación vivienda/hipoteca para lograr otro aspecto. Una nueva carcasa
  visual no convierte cierres discretos en curvas ni oculta la deuda dentro de
  una banda neta distinta.
- No se introduce una API de lectura, una SPA ni una librería de charts como
  sustituto de los SVG/funciones de dominio; son decisiones arquitectónicas ya
  descartadas por [ADR 0036](../adr/0036-client-interactivity-where-it-earns-its-keep.md).

## 3. Accesibilidad e interacción perceptible

### Obligatorio

- Todo control conserva operación por teclado, foco visible y semántica nativa
  cuando exista (`<a>`, `<form>`, `<details>`). El estado seleccionado se expone
  con `aria-current` o `aria-pressed`; guardado y resultado se anuncian con
  `aria-live`.
- Un cambio de vista, rango o drill en cliente no puede dejar perdido al usuario
  de teclado o lector de pantalla: debe mover el foco al contenido actualizado o
  anunciarlo, y devolverlo al cerrar. Es obligatorio aunque la cobertura e2e
  actual se concentre en teclado/estado, no en cada traslado de foco.
- Las transiciones respetan `prefers-reduced-motion`; si View Transitions no
  está disponible, la navegación se degrada limpiamente y conserva el contenido
  accesible.

### Mandatos y pruebas que lo cubren

- La sección de accesibilidad de los [patrones de interacción](../interaction-patterns.md)
  es el mandato explícito para teclado, foco, ARIA y anuncios; también prohíbe
  que los islands regresen la accesibilidad que aportaban controles nativos.
- [`33-framing-toggle.spec.ts`](../../e2e/33-framing-toggle.spec.ts) y
  [`39-exposure-lens.spec.ts`](../../e2e/39-exposure-lens.spec.ts) cubren teclado
  y `aria-current`; [`26-composition-range.spec.ts`](../../e2e/26-composition-range.spec.ts)
  cubre el estado ARIA del rango. [`operations-editor.tsx`](../../apps/web/app/_components/operations-editor.tsx)
  mantiene una región `aria-live` y una banda de error con `role="alert"` para
  las operaciones.
- [`view-transitions.ts`](../../apps/web/app/view-transitions.ts) y sus
  [pruebas](../../apps/web/app/view-transitions.test.ts) preservan el fallback
  sin API; [`motion-tokens.test.ts`](../../apps/web/app/motion-tokens.test.ts)
  exige seis tokens raíz de movimiento y el conjunto cerrado de literales
  temporales.

### Restricciones

- El rediseño no puede reemplazar enlaces o botones semánticos por contenedores
  clicables, retirar nombres accesibles ni depender de hover o animación para
  entender cifras y controles.
- El movimiento es decorativo y reducible; no se usa para ocultar un cambio de
  estado, una carga o un error.

## 4. RSC-first, URL y mutaciones

### Obligatorio

- Las cifras, series y geometría llegan renderizadas por el servidor, sin
  spinner previo a los números. El cliente solo contiene islands pequeños para
  estado efímero, tooltip, transición o feedback de mutación.
- Los estados de vista existentes permanecen cargables y compartibles desde la
  URL: `view`, `range`, `drill` y `vivienda`, además de los demás estados de
  superficie que ya modela [`view-state.ts`](../../apps/web/app/view-state.ts).
  Al conmutar se reflejan con `history.pushState`, se conserva el resto de los
  parámetros y Atrás/Adelante los restaura mediante `popstate`, sin recarga de
  documento.
- Los enlaces conservan `href` para no-JS, deep-link, abrir en otra pestaña y
  clic modificado. La navegación entre superficies evita flash y salto de scroll;
  los drills cambian su vista en sitio y el breadcrumb mantiene los parámetros
  que no está cerrando.
- Las mutaciones predecibles siguen siendo optimistas sobre Server Actions; si
  falla la acción, se revierte y se muestra el error. Si un cálculo depende del
  servidor, muestra pending honesto, no una cifra anticipada. El modo demo no
  simula optimismo para mutaciones que el write-guard rechaza.

### Mandatos y pruebas que lo cubren

- [ADR 0036](../adr/0036-client-interactivity-where-it-earns-its-keep.md) y los
  [patrones de interacción](../interaction-patterns.md) son el mandato RSC-first:
  datos autoritativos en servidor, estado local, sin store global ni API nueva.
- [`view-state.test.ts`](../../apps/web/app/view-state.test.ts) prueba lectura
  validada, default omitido, sustitución de la clave y preservación de parámetros
  ajenos. Los e2e [de framing](../../e2e/33-framing-toggle.spec.ts),
  [de rango](../../e2e/26-composition-range.spec.ts) y
  [de drill](../../e2e/11-liquid-drilldown.spec.ts) prueban URL, deep-link,
  Atrás y ausencia de recarga.
- [`optimistic-operations.ts`](../../apps/web/app/_components/optimistic-operations.ts)
  separa el merge predecible de los derivados calculados por servidor y sus
  [pruebas](../../apps/web/app/_components/optimistic-operations.test.ts) cubren
  altas, bajas y ausencia de filas fantasma. [`view-transition-link.tsx`](../../apps/web/app/view-transition-link.tsx)
  conecta la navegación de secciones con el fallback de transición.

### Restricciones

- No se cambia una interacción instantánea por navegación completa, ni se cambia
  una URL existente por estado opaco de componente. A la inversa, una navegación
  que cambia realmente el dataset no se clientifica por estética.
- No se cambia la fuente de verdad al cliente, no se añade estado global y no se
  alteran rutas, Server Actions, payloads ni condiciones de demo. El límite es
  visual, no funcional.

## 5. PWA y datos financieros bajo red deficiente

### Obligatorio

- La aplicación sigue siendo instalable con su manifest, `theme_color`,
  `background_color`, `start_url`, iconos y registro de `sw.js`. Los activos PWA
  públicos continúan accesibles incluso con autenticación configurada.
- El service worker cachea shell y activos estáticos; documentos, acciones y
  cifras permanecen **network-first**. Sin red se muestra un estado honesto de
  reintento, nunca una cifra cacheada que parezca actual.
- La pantalla offline conserva la semántica visual básica (papel, tinta, panel,
  borde, verde y muted) y explica que las cifras autoritativas requieren red.

### Mandatos y pruebas que lo cubren

- [ADR 0036](../adr/0036-client-interactivity-where-it-earns-its-keep.md) y la
  sección PWA de los [patrones de interacción](../interaction-patterns.md)
  fijan shell cacheado y datos network-first.
- [`layout.tsx`](../../apps/web/app/layout.tsx),
  [`sw-register.tsx`](../../apps/web/app/_components/sw-register.tsx),
  [`manifest.json`](../../apps/web/public/manifest.json) y
  [`sw.js`](../../apps/web/public/sw.js) son la fuente de los metadatos, registro,
  caché y fallback offline actuales.
- [`34-pwa.spec.ts`](../../e2e/34-pwa.spec.ts) verifica manifest servido,
  registro activo y que un activo estático funciona offline mientras un documento
  dinámico falla o devuelve la página offline. [`auth-gate.test.ts`](../../apps/web/app/auth-gate.test.ts)
  y [`web-public-assets.test.ts`](../../tests/tooling/web-public-assets.test.ts)
  cubren accesibilidad pública y existencia de los activos.

### Restricciones

- No se emplea una versión visual cacheada de una pantalla financiera para
  presentar datos antiguos como actuales. La migración no convierte el PWA en
  modo offline de datos ni modifica su política de caché.

## 6. Matriz mínima de conservación

| Contrato obligatorio | Mandato principal | Cobertura ejecutable existente |
| --- | --- | --- |
| Semántica de color, contraste, tipografía y movimiento | [Sistema de diseño](../design-system.md) | [`contrast.test.ts`](../../apps/web/app/contrast.test.ts), [`form-label-style.test.ts`](../../apps/web/app/form-label-style.test.ts) para selector compartido y tres prohibiciones, y [`motion-tokens.test.ts`](../../apps/web/app/motion-tokens.test.ts) para seis tokens raíz y un conjunto cerrado de literales temporales |
| Ecuación, barras discretas, vivienda neta y drill | [ADR 0009](../adr/0009-server-rendered-svg-charts.md), [ADR 0032](../adr/0032-discrete-bar-charts-show-housing-net.md) | [`composition-chart.test.ts`](../../packages/domain/src/composition-chart.test.ts), [`composition-chart.test.tsx`](../../apps/web/app/composition-chart.test.tsx), e2e 11/25/26 |
| Teclado, ARIA, foco y movimiento reducible | [Patrones de interacción](../interaction-patterns.md) | e2e 26/33/39, [`view-transitions.test.ts`](../../apps/web/app/view-transitions.test.ts) |
| RSC-first, URL, Atrás y optimismo honesto | [ADR 0036](../adr/0036-client-interactivity-where-it-earns-its-keep.md) | [`view-state.test.ts`](../../apps/web/app/view-state.test.ts), e2e 11/26/33, [`optimistic-operations.test.ts`](../../apps/web/app/_components/optimistic-operations.test.ts) |
| Instalabilidad y datos network-first | [Patrones PWA](../interaction-patterns.md) | [`34-pwa.spec.ts`](../../e2e/34-pwa.spec.ts), [`auth-gate.test.ts`](../../apps/web/app/auth-gate.test.ts), [`web-public-assets.test.ts`](../../tests/tooling/web-public-assets.test.ts) |

## 7. Comandos de validación definidos por el repositorio

Para una futura modificación visual, ejecutar desde la raíz del repositorio:

```sh
bun run verify
bun run test:e2e
bun run build
```

- `bun run verify` es la puerta rápida por defecto: typecheck, Biome y pruebas
  unitarias/integración.
- `bun run test:e2e` cubre los contratos de navegador, incluidos URL, drills,
  teclado y PWA.
- `bun run build` es la puerta de producción/pre-push e incluye el build de Next.

El detalle y alcance de esas puertas está definido en la
[guía de verificación](../agents/verification-gate.md) y los scripts exactos en
[`package.json`](../../package.json).

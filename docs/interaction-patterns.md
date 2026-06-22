# Patrones de interacción de worthline

Guía de comportamiento del front (RSC-first, junio 2026). Es el complemento de
[`design-system.md`](./design-system.md): aquel dice **cómo se ve** una página;
este dice **cómo se siente al tocarla**. Origen: **ADR 0036** (interactividad de
cliente donde se la gana) + PRD #485, que relajan el _default_ «cero JS» de
**ADR 0009** sin romper sus principios.

Premisa rectora del usuario: **«lo malo es la experiencia; la tecnología es solo
un vehículo»**. Toda regla de aquí existe para que una interacción que _debería_
ser gratis (conmutar una vista, cambiar un filtro, editar un dato) lo sea — sin
recarga de página, sin spinner, sin perder el sitio.

## 0. La frase de una línea

> **Las cifras se renderizan en el servidor y se ven al instante. La interacción
> ocurre en el cliente sin round-trip. La URL sigue siendo la fuente de verdad
> al cargar y al compartir.**

Si una página nueva cumple eso, está alineada. El resto son detalles de cómo.

## 1. El reparto servidor / cliente

| Tipo de estado                                                                                  | Dónde vive           | Mecanismo                                                                   |
| ----------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------- |
| **Cifras y geometría** (patrimonio, capas, series, geometría de gráficas)                       | Servidor (RSC)       | Render en servidor; sin spinner antes de los números                        |
| **Vista efímera** (framing neto↔líquido, rango 1A/3A/5A/Todo, densidad, abrir/cerrar drilldown) | Cliente              | El servidor manda los datos de las alternativas una vez; el cliente conmuta |
| **Mutaciones** (editar/añadir/borrar/restaurar holding, operación, ownership, puesta al día)    | Servidor + optimista | Server Action + `useOptimistic` para feedback inmediato                     |
| **Datos autoritativos** (todo lo que persiste)                                                  | Servidor             | Server Action / carga RSC. Nunca «fuente de verdad» en el cliente           |

La pregunta de diseño para cualquier control nuevo es **una sola**: _¿esto cambia
un dato, o solo cambia qué dato estoy mirando?_ Lo segundo es estado de cliente y
**no debe costar una navegación**.

## 2. Conmutar una vista NO recarga la página (regla dura)

Cambiar el framing, el rango temporal, la densidad o abrir un drilldown **no
dispara una navegación de documento**. Hoy lo hacen (son `<Link>`/`<a>` en
`dashboard-content.tsx` — cada clic paga un round-trip a Turso); ese es
precisamente el _antes_ que esta guía deroga.

- **Antes (deroga):** `<Link href={compositionUrl("liquid", …)}>Líquido</Link>` →
  recarga, flash, salto de scroll.
- **Después (canon):** un island conmuta el dato ya presente en cliente y refleja
  el cambio en la URL **sin** round-trip (§3). El servidor mandó ambas framings
  de una vez.

Excepción legítima: si traer _todas_ las alternativas a la vez fuera caro de
verdad (p. ej. cambiar de **scope**, que cambia el dataset entero), esa superficie
puede seguir navegando — pero es una decisión consciente y anotada, no el default.

## 3. La URL es la fuente de verdad; el toggle la refleja con `pushState`

Un toggle de cliente instantáneo y una URL compartible/marcable **no están en
conflicto**:

- Al **cargar**, el estado se lee de los `searchParams` (deep-link y recarga
  funcionan idénticos a hoy).
- Al **conmutar**, el island actualiza el dato y **espeja a la URL con
  `history.pushState`** — sin round-trip.
- El **botón Atrás** debe devolver al estado anterior (escuchar `popstate`).

Regla: **ningún estado de vista que hoy esté en la URL puede dejar de estarlo.**
«Ocultar vivienda», rango, framing y drill siguen siendo enlazables después de
clientificarse. Si rompes el deep-link, rompiste el patrón.

## 4. Mutaciones optimistas

Toda mutación (las ~11 Server Actions: holding crear/editar/borrar, restaurar de
la papelera, operación, ownership, puesta al día) muestra su resultado **antes**
de que la acción resuelva:

- `useOptimistic` aplica el cambio en la UI al instante; la Server Action persiste
  en background.
- Si la acción **falla**, se revierte el estado optimista y se muestra el error
  (no se traga — ver `coding-style`/`error-handling`).
- El estado de guardado se **anuncia** (`aria-live`): _guardando…_ → _guardado_.
- No se bloquea la UI con un spinner global mientras guarda; el cambio ya está
  visible y se confirma o revierte.
- **Optimista solo si el resultado es predecible.** Cuando el valor lo computa el
  servidor y no se puede adivinar en cliente (p. ej. «Actualizar precios» que trae
  cotizaciones del proveedor, #405/#406), **no se finge** un valor optimista: se
  muestra un **pending honesto e inline** en esa fila y se confirma con el dato
  real. Optimismo falso > sin feedback, pero un número inventado que luego salta
  al real es peor que un pending breve.

## 5. Navegación sin flash: View Transitions + scroll estable

Moverse entre dashboard ↔ histórico ↔ drilldowns **no parpadea en blanco ni
pierde la posición de scroll**:

- Se usa la **View Transitions API** por el camino soportado de Next 16 / React 19.
- La elegibilidad de transición (cuándo animar, cuándo no) vive en un módulo puro
  testeable (§7), no esparcida por los componentes.
- Si el navegador no soporta View Transitions, **degradado limpio**: navegación
  normal, nunca una transición rota.
- **Respeta `prefers-reduced-motion`**: si el usuario lo pide, se omite la
  animación (cambio directo, igual sin flash). El movimiento es un lujo, no un
  requisito.

## 6. Las gráficas son islands que envuelven geometría pura

- La **geometría y la matemática** (puntos, arcos, barras, escalas) siguen siendo
  **funciones puras síncronas en `packages/domain`**, server-rendered como SVG.
- La interactividad (tooltip que sigue al cursor, hover, zoom) se añade con un
  **island que envuelve** ese SVG — **no** se sustituye por una librería de charts
  por defecto.
- Canon vivo: la gráfica de composición (#143) — `composition-chart-hover.ts`
  (lógica pura) + `composition-chart-hover.test.ts` + `composition-chart.tsx`
  (cáscara fina). Deja de ser la excepción y pasa a ser **el patrón**.
- Qué gráficas ganan interactividad y cuáles drilldowns se clientifican es
  **decisión por-gráfica / por-superficie** (Phase 1, priorizada por el spike
  #486), no un barrido.

## 7. La lógica de interacción vive en módulos puros

El componente cliente es una **cáscara fina**; la lógica es una función pura
testeable al lado, con su `.test.ts` (entorno `node` de vitest). Patrón
establecido por `composition-chart-hover.ts`.

- El **reducer del toggle** (estado de vista ↔ acción): módulo puro con `.test.ts`.
- La **función de merge optimista** (estado base + cambio pendiente): módulo puro con `.test.ts`.
- La **elegibilidad de transición**: módulo puro con `.test.ts`.

Se prueba **comportamiento observable por el usuario**, no detalles de
implementación ni estructura interna de componentes. No se añade jsdom/RTL: la
estructura se asevera con `renderToStaticMarkup` (patrón existente) y el
comportamiento interactivo con Playwright (e2e) + los módulos puros (unit).

## 8. Accesibilidad: los islands no la regresan

El diseño zero-JS daba a11y casi gratis (links, forms, `<details>` nativos).
Cada control interactivo nuevo **debe conservarla explícitamente**:

- Totalmente **operable por teclado**, con **foco visible**.
- Estado **anunciado**: `aria-current`/`aria-pressed` para la vista/rango
  seleccionado; `aria-live` para guardando/guardado.
- **Gestión de foco al conmutar en cliente.** Como abrir un drilldown o cambiar de
  vista ya **no** es una navegación de documento, el lector de pantalla no lo
  anuncia solo: hay que **mover el foco** al contenido nuevo (o anunciarlo por una
  región `aria-live`) y devolverlo al cerrar. Sin esto, un usuario de teclado/SR
  pierde el sitio — la regresión silenciosa más fácil de cometer al clientificar.
- Se asevera en la capa e2e (la a11y es criterio de aceptación, no un extra).

## 9. PWA: shell cacheado, datos network-first

- El **shell** (chrome de la app) se cachea con un service worker (Serwist/
  next-pwa) para instalabilidad y arranque instantáneo, incluso en red mala.
- Las **cifras van network-first**: son autoritativas y se computan en servidor;
  nunca se sirve un número viejo de caché como si fuera el actual.
- El PWA cachea el shell, **no** datos offline reales (eso es decisión posterior,
  por superficie, atada a Option B).
- **Fallo de red con dignidad.** Si una carga network-first falla (red mala), se
  degrada con un estado honesto (reintentar, o el último valor **marcado como
  obsoleto**) — nunca un shell roto ni un número viejo presentado como el actual.

## 10. Escalación contenida

- El estado de cliente es **local a la superficie interactiva** (React
  state/reducer). **Sin librería global de estado** por defecto.
- **No se construye API de lectura ni SPA ni app nativa.** Móvil = el PWA.
- Si una superficie concreta sigue sintiéndose _server-bound_ después de Phase 0,
  _esa_ superficie (y solo esa) puede pasar a client-data + read API (la Option B
  reservada de ADR 0036) — nunca la app entera.
- **Demo no se ve afectado:** los **toggles de vista (read-only)** funcionan igual
  de fluidos. Pero las **mutaciones no deben fingir optimismo** en demo — el
  write-guard las rechaza, así que un cambio optimista seguido de revert sería un
  parpadeo falso. En demo, los controles de mutación se deshabilitan/ocultan o,
  como mínimo, no aplican estado optimista.

## 11. Presupuesto de JS: no clientificar de más

RSC-first es también una defensa contra el coste. Cada island añade JS al bundle;
ADR 0036 eligió este camino en parte para **no** enviar «materialmente más JS».

- Un island debe **ganarse su peso**: si una interacción no mejora de verdad la
  experiencia, se queda en servidor. La duda se resuelve a favor del servidor.
- **El island más pequeño que resuelve el problema gana.** Se envuelve la
  geometría/markup existente; no se reimplementa en cliente lo que ya rinde el
  servidor.
- El **baseline de S0 (#516)** es la vara: si una slice engorda el bundle de una
  ruta de forma notable, se justifica contra la mejora medible — no por intuición.

## 12. Checklist para una interacción nueva

- [ ] ¿Las cifras se ven al cargar sin spinner? (server-render)
- [ ] ¿Cambiar filtro/vista/rango/densidad ocurre **sin recarga de página**? (§2)
- [ ] ¿El estado de vista se lee de la URL al cargar y se espeja con `pushState` al conmutar? ¿Deep-link y Atrás funcionan? (§3)
- [ ] ¿Las mutaciones son optimistas (o pending honesto si el resultado no es predecible), con revert+error si fallan y `aria-live` de guardado? (§4)
- [ ] ¿La navegación va sin flash ni salto de scroll, con degradado limpio y respetando `prefers-reduced-motion`? (§5)
- [ ] ¿La gráfica interactiva envuelve geometría pura de `packages/domain`, no la sustituye? (§6)
- [ ] ¿La lógica (reducer/merge/elegibilidad) está en un módulo puro con `.test.ts` y el componente es una cáscara fina? (§7)
- [ ] ¿Teclado, foco visible, ARIA anunciado y **foco gestionado** al conmutar en cliente? (§8)
- [ ] ¿El fallo de red se degrada con dignidad y la demo no finge optimismo? (§9, §10)
- [ ] ¿Estado local a la superficie, sin store global, sin API nueva? (§10)
- [ ] ¿El island se gana su peso de JS frente al baseline de S0? (§11)

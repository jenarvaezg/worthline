# Inventario de superficies — migración «Libro mayor»

> Investigación para [Inventariar las superficies de la migración «Libro mayor»](https://github.com/jenarvaezg/worthline/issues/827). Complementa la [propuesta A](01-propuesta-a-libro-mayor.md); no la sustituye ni define la solución visual de cada superficie.

## Alcance

La migración abarca toda la interfaz de `apps/web`: rutas autenticadas y autónomas, capas que monta el layout raíz, estados de carga/vacío/error y sus variantes móvil. Las rutas principales comparten `Shell`, pero no un layout anidado; por ello el shell y sus bandas se migran como superficie propia ([`layout.tsx`](../../apps/web/app/layout.tsx), [`shell.tsx`](../../apps/web/app/shell.tsx)).

Sin workspace, las rutas privadas `/`, `/historico`, `/objetivos`, `/patrimonio`, sus flujos de actualización/alta/importación/edición y `/ajustes` redirigen a `/empezar`; no son vistas vacías de cada ruta. Crear individual u hogar desde onboarding lleva a `/patrimonio/anadir`.

Los prototipos de desarrollo y `?variant=` no son una superficie de destino: son andamiaje que se retirará cuando la receta se absorba.

## Matriz de rutas

| Superficie | Entrada | Estados que debe cubrir la migración | Vistas de aceptación |
| --- | --- | --- | --- |
| Resumen | `/` · [`page.tsx`](../../apps/web/app/page.tsx) | Sin workspace → `/empezar`, skeleton streaming, cambio de ámbito/privacidad/vista, vacío, FIRE no configurado y onboarding pendiente. | `1440×1024`; `390×844` con dashboard apilado y métricas 2×2. |
| Histórico | `/historico` · [`page.tsx`](../../apps/web/app/historico/page.tsx) | Sin workspace → `/empezar`, primera captura/sin movimientos, tabla contraída y día expandido, segundo drill por posición, cierre mensual/subtotal, ámbito y privacidad. | `1440×1024` contraído y expandido; `390×844` contraído y expandido, con delta y barras ocultas. |
| Objetivos | `/objetivos` · [`page.tsx`](../../apps/web/app/objetivos/page.tsx) | FIRE sin configurar, calculado, alcanzado y Coast FIRE; proyección sin edad; metas; renta pasiva sin cobros/sin gasto/cobertura; error y éxito de formulario. | `1440×1024`; `390×844` en una columna, sin truncar los estados FIRE ni renta pasiva. |
| Patrimonio | `/patrimonio` · [`page.tsx`](../../apps/web/app/patrimonio/page.tsx) | Agrupación/lente por URL, avisos, feedback, cartera vacía/no vacía, papelera, mutación optimista/pending/rollback y solo lectura demo. | `1440×1024`; `390×844` con filtros, board y tablas en su patrón móvil. |
| Actualizar patrimonio | `/patrimonio/actualizar` · [`page.tsx`](../../apps/web/app/patrimonio/actualizar/page.tsx) | Formulario por holding, errores preservados, éxito, vacío, mutación optimista/pending/rollback y solo lectura demo. | `1440×1024`; `390×844` con formulario de una columna. |
| Añadir patrimonio | `/patrimonio/anadir` · [`page.tsx`](../../apps/web/app/patrimonio/anadir/page.tsx) | Primera alta, cajón/instrumento elegido, búsqueda de símbolo con resultados/sin resultados/selección, fallback manual sin cotización, precio, error y ciclo de éxito. | `1440×1024`; `390×844` con búsqueda, vacío y fallback manual. |
| Añadir avanzado | `/patrimonio/anadir/avanzado` · [`page.tsx`](../../apps/web/app/patrimonio/anadir/avanzado/page.tsx) | Instrumento seleccionado, búsqueda de símbolo con resultados/sin resultados/selección, fallback manual sin cotización, panel vacío, error y éxito. | `1440×1024`; `390×844` con búsqueda, vacío y fallback manual. |
| Importar extracto | `/patrimonio/importar-extracto` · [`page.tsx`](../../apps/web/app/patrimonio/importar-extracto/page.tsx) | Previsualización, importación, error/éxito y solo lectura demo. | `1440×1024`; `390×844` con previsualización y error. |
| Editar posición | `/patrimonio/:id/editar` · [`page.tsx`](../../apps/web/app/patrimonio/[id]/editar/page.tsx) | Activo/deuda, inexistente → 404, avisos, subformularios, valoración, integración, operaciones optimistas/pending/rollback y demo de solo lectura. Si la posición viene de Numista/Binance: fuente conectada, posiciones vacías, valoración Numista desactualizada, token sin precio, histórico Binance y acciones de sincronizar/desconectar. | `1440×1024`; `390×844` con subformularios e integración apilados. |
| Ajustes | `/ajustes` · [`page.tsx`](../../apps/web/app/ajustes/page.tsx) | Miembros activos/inactivos, FIRE, overrides vacíos, zona irreversible ausente en demo; Numista/Binance desconectada, conectar, credenciales erróneas, sincronización pendiente y desconexión confirmada. | `1440×1024`; `390×844` con fuentes y zona irreversible en una columna. |
| Acceso | `/login` · [`page.tsx`](../../apps/web/app/login/page.tsx) | Inicio de Google y enlace al demo. | `1440×1024`; `390×844`. |
| Onboarding | `/empezar` · [`page.tsx`](../../apps/web/app/empezar/page.tsx) | Redirección si ya existe workspace; alta individual/hogar que lleva a `/patrimonio/anadir`; importación por selección de archivo → preview pendiente/error/resumen → confirmación, donde cambiar el archivo invalida el preview; errores preservados. | `1440×1024`; `390×844` con preview de importación. |
| Selección demo | `/demo` · [`page.tsx`](../../apps/web/app/demo/page.tsx) | Redirección de persona autenticada, tres personas y deep-link `?persona=`. | `1440×1024`; `390×844`. |
| Administración | `/admin` · [`page.tsx`](../../apps/web/app/admin/page.tsx) | Acceso no administrador → 404, listado e impersonación. | `1440×1024`; `390×844`. |
| Límites de fallo | [`error.tsx`](../../apps/web/app/error.tsx) y [`not-found.tsx`](../../apps/web/app/not-found.tsx) | Reintento, volver al resumen, URL inexistente y administración denegada. | `1440×1024`; `390×844`. |

## Capas que cruzan rutas

| Capa | Evidencia | Estados y requisito de migración |
| --- | --- | --- |
| Shell | [`shell.tsx`](../../apps/web/app/shell.tsx) | Topbar, navegación, selector de ámbito, avisos y footer. La navegación de registro de la propuesta no cubre aún tabs de ámbito ni el cierre de sesión móvil. |
| Acceso protegido | [`proxy.ts`](../../apps/web/proxy.ts), [`auth-gate.ts`](../../apps/web/app/auth-gate.ts) | Con Auth configurado, toda ruta no pública redirige a `/login`; la cookie demo y el modo local son excepciones que deben conservar el mismo trato visual. |
| Demo e impersonación | [`layout.tsx`](../../apps/web/app/layout.tsx), [`demo-banner.tsx`](../../apps/web/app/demo/demo-banner.tsx), [`impersonation-banner.tsx`](../../apps/web/app/admin/impersonation-banner.tsx) | Bandas persistentes sobre cualquier ruta; requieren una receta explícita, no heredar las tarjetas actuales. |
| Asistente | [`assistant-mount.tsx`](../../apps/web/app/asistente/assistant-mount.tsx), [`assistant-layer.tsx`](../../apps/web/app/asistente/assistant-layer.tsx) | FAB, panel, vacío, streaming, error, acciones y propuestas: confirmación pendiente, aplicada, bloqueada por demo/error y descartada. No tiene ruta propia y la propuesta A no lo receta; validar ese ciclo en panel lateral a `1440×1024` y bottom sheet a `390×844`. |
| Transiciones sin pantalla | [`persona/route.ts`](../../apps/web/app/demo/persona/route.ts), [`exit/route.ts`](../../apps/web/app/demo/exit/route.ts), [`scope/route.ts`](../../apps/web/app/scope/route.ts), [`privacy/route.ts`](../../apps/web/app/privacy/route.ts), [`export/route.ts`](../../apps/web/app/ajustes/export/route.ts) | Cambios de persona, salida demo, ámbito, privacidad y exportación deben conservar su feedback y navegación sin destello. |
| Navegación y scroll de formulario | [`form-submit-scroll-keeper.tsx`](../../apps/web/app/form-submit-scroll-keeper.tsx), [`view-transition-link.tsx`](../../apps/web/app/view-transition-link.tsx) | Restauración de scroll tras un submit y enlaces con transición sin destello; validar ambos a `1440×1024` y `390×844`. |
| Andamiaje de desarrollo | [`page.tsx`](../../apps/web/app/page.tsx), [`prototipo-deuda-estado/page.tsx`](../../apps/web/app/patrimonio/prototipo-deuda-estado/page.tsx), [`prototipo-extracto/page.tsx`](../../apps/web/app/patrimonio/prototipo-extracto/page.tsx) | El selector `?variant=` y las rutas de prototipo se eliminan al absorber la receta; fuera de desarrollo ya son 404. |

## Contratos visuales transversales

| Área | Base actual | Cobertura de «Libro mayor» | Hueco que resolver |
| --- | --- | --- | --- |
| Tipo y tokens | Source Sans e Iosevka; Bitter ya se carga en el layout. | El prototipo aplica Bitter y paleta editorial bajo `data-prototype-variant`. | Convertir la jerarquía acordada —Bitter en `h1`/`h2`, Source Sans en cuerpo y controles, Iosevka en cifras/etiquetas— en contrato global y retirar la guía que aún describe el mix. |
| Superficies | Paneles con fondo, borde suave, radio y sombra. | Hero, liquidez, histórico, FIRE y onboarding del resumen se vuelven secciones regladas. | Crear una primitiva compartida de sección reglada para paneles, formularios, lecturas y contenedores. |
| Controles | Botones, foco, tabs, chips e inputs son reglas globales. | Solo se adaptan `framingTabs`, `rangeTabs` y algunos chips. | Definir controles rectangulares de 4 px para botones, inputs, acciones secundarias y `.scopeTabBtn`. |
| Tablas y estados de dato | Hairlines, cifras tabulares y `statePill`. | La propuesta prescribe bandas, subtotales y reglas pesadas. | Implementar banding, subtotales, cortes anuales y semántica de estado sin mantener píldoras heredadas. |
| Gráficas | Capas, barras y gráficas usan `--tier-*`. | El resumen ensaya papel pautado, rellenos opacos y trama de ilíquidos. | Llevar patrones a SVG donut/barras ilíquidas y a visualizaciones ajenas al resumen. |
| Estados de interfaz | Skeleton, `PendingSubmit`, figuras vacías, bandas de error y error del asistente; patrimonio y operaciones además mutan de forma optimista antes de responder. | Solo heredan los tokens del resumen prototipado. | Recetar carga, vacío, optimista, pendiente, éxito, rollback, aviso, error y reintento para todo el sistema, con la excepción de demo solo lectura. |
| Capas raíz | Banners demo/impersonación y asistente conservan tarjetas, radios y sombras. | Sin cobertura. | Resolverlas antes de validar la migración como completa. |

## Cobertura responsive

La base actual reduce grids progresivamente en `980px`, `900px`, `820px` y `780px`; transforma paneles auxiliares en bottom sheet y simplifica densidad en `720px`/`700px`; a `640px` reduce padding, apila el shell y formularios y activa scroll horizontal de tablas; a `560px` termina de apilar campos ([`globals.css`](../../apps/web/app/globals.css)).

La aceptación debe registrar al menos una captura de escritorio y otra móvil por cada fila de la matriz, además de las siguientes fixtures: acceso no autenticado y sus excepciones, redirección sin workspace, hogar multiámbito, demo, impersonación, admin denegado, histórico vacío y expandido, FIRE ausente/alcanzado, renta pasiva sin gasto/cobros, cartera vacía, mutación optimista y rollback, edición inexistente, integración conectada/sin posiciones/desactualizada/sin precio, preview de importación, restauración de scroll, navegación sin destello y propuesta del asistente pendiente/aplicada/bloqueada/descartada. El riesgo móvil prioritario es la navegación: la variante de libro mayor evita el salto de línea de enlaces, pero no integra todavía «Cerrar sesión» en la misma banda desplazable.

## Resultado para el mapa

La propuesta A es una receta convincente del resumen, pero no todavía un sistema de diseño global. Antes de planificar la migración deben concretarse contratos reutilizables para shell, sección, controles, tabla, visualización, estados y capas raíz; y decidir el tratamiento de las superficies que la propuesta no receta.

# Sure vs Worthline: oportunidad técnica y de producto

Fecha: 2026-07-11  
Worthline: [`f8f1418`](https://github.com/jenarvaezg/worthline/tree/f8f1418a58eeccf7c7f10fb0c9143b956f015797)  
Sure: [`8d649bc`](https://github.com/we-promise/sure/tree/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe)  
Análisis upstream detallado: [sure-upstream-analysis.md](./sure-upstream-analysis.md)

## Veredicto

Sure es hoy un producto mucho más ancho y operacionalmente acabado. Worthline tiene un
modelo patrimonial más profundo, explícito y defendible. La oportunidad no es construir
un Sure pequeño, sino incorporar su madurez de conectividad, operación y distribución
sin heredar su complejidad accidental.

La comparación tampoco parte de condiciones equivalentes: Sure continúa Maybe Finance,
cuyo README declara cerca de un millón de dólares invertidos en desarrollo durante
2021–2022. La copia revisada tiene 5.013 ficheros, 115 tablas, centenares de modelos y
una comunidad de aproximadamente 8.900 estrellas y 236 forks. Su acabado es evidencia
de años-persona acumulados, no de que Worthline haya elegido mal.

## Comparación directa

| Dimensión | Sure | Worthline | Ventaja |
|---|---|---|---|
| Amplitud diaria | Transacciones, categorías, merchants, reglas, budgets, splits, transfers y recurring | Patrimonio, historia, vivienda, deuda, inversión, FIRE y planificación | Sure |
| Conectores | Amplio catálogo de bancos, brokers y exchanges | Pricing sólido; fuentes conectadas todavía escasas | Sure |
| Core patrimonial | `Account`/`Entry`/balances/holdings materializados, con varios estados de verdad | Holding, instrumento, liquidez y valoración separados; truth/reference/forecast explícitos | Worthline |
| Historia | Series diarias materializadas y reconstruibles | Snapshots congelados, hechos fechados y ripple atómico | Worthline |
| Deuda/vivienda | Tipos de cuenta generales; amortización nativa aún solicitada | Tasaciones, apreciación, hipoteca, revisiones y amortización anticipada | Worthline |
| Analítica | Net worth, cash flow, inversión y budgets | Neto/líquido, look-through, cobertura, IRR/TWR, benchmarks, FIRE y origen del cambio | Worthline |
| Jobs/operación | Sidekiq, cron, retries, locks, estados y health | Cron/manual; parte del refresh aún ocurre en el GET | Sure |
| Plataforma | REST/OpenAPI, OAuth, API keys, MCP y Flutter | Agent view/MCP/chat coherentes; API y móvil más estrechos | Sure |
| Local-first | PostgreSQL + Redis + Rails | SQLite local sin auth ni cloud por defecto | Worthline |
| Rendimiento | Materialización y observabilidad real, pero N+1, scans y dashboard de 10 s abiertos | Harness determinista y budgets; hot paths conocidos | Empate complementario |
| Diseño | Tokens compilados, componentes y catálogo vivo | Buen canon escrito; migración «Libro mayor» aún en curso | Sure hoy |
| Asistente | Amplio y con tools mutantes compartidos | Facts read-only y propuestas preview→confirm | Worthline |
| Distribución | Docker, Compose, Helm, backups y releases móviles | Local/Vercel, instalación menos producto | Sure |

## Lo que Sure hace mejor y merece adaptación

1. **Sincronización como objeto de producto.** Un sync tiene estado, ventana, intentos,
   errores, parent/children y recuperación. No es una llamada HTTP escondida al abrir
   una pantalla.
2. **Procedencia y prioridad del dato.** Sure intenta declarar qué gana entre dato
   manual bloqueado, snapshot del proveedor y cálculo derivado.
3. **Loop completo de conectores.** Conectar, descubrir cuentas, importar, normalizar,
   reconciliar, materializar, corregir y resincronizar.
4. **Sistema visual ejecutable.** Tokens versionados, componentes reutilizables,
   previews y vigilancia de drift, no sólo una guía escrita.
5. **Self-hosting como producto.** Instalación, health checks, backups, upgrades e
   imágenes multi-arquitectura forman parte de la experiencia.
6. **Observabilidad de tráfico real.** Skylight/Sentry/profilers complementan las
   pruebas sintéticas y hacen visibles los percentiles y queries de producción.

## Lo que Worthline ya hace mejor

1. **Semántica patrimonial.** La separación entre holding, instrumento, liquidez y
   método de valoración evita que el tipo de cuenta decida implícitamente toda la
   matemática.
2. **Integridad temporal.** Los hechos fechados, snapshots congelados y ripple hacen
   explícita la reconciliación histórica. En Sure, la verdad se replica entre entries,
   balances, holdings, saldos de cuenta y payloads; su backlog contiene fallos de coste,
   FX, transfers y gap-fill que alcanzan las cifras.
3. **Hogar real.** Usuario, workspace, grant, member, scope y ownership son conceptos
   distintos. Sure aún tiene abierta la capacidad de varios ledgers por usuario.
4. **Vivienda y deuda.** Worthline ya tiene el modelo de amortización que Sure solicita
   en [#1804](https://github.com/we-promise/sure/issues/1804).
5. **Wealth analytics.** Liquidez, exposición look-through con cobertura, retornos
   diferenciados, benchmarks, FIRE y contribuciones forman una propuesta más profunda.
6. **Honestidad y seguridad del asistente.** El agente consume hechos internos y una
   mutación nace como propuesta confirmable. No se le entrega una herramienta que pueda
   convertir una interpretación en verdad silenciosamente.
7. **Local-first ligero.** Worthline arranca con SQLite y sin infraestructura; Sure tiene
   abierta una petición de modo totalmente local en
   [#1152](https://github.com/we-promise/sure/issues/1152).
8. **Performance preventiva.** Los budgets deterministas evitan regresiones antes de
   observarlas en usuarios. Sure aporta la mitad complementaria: telemetría real.

## Refactors recomendados

### P0 — Hacer de home una query pura

Completar el mapa [#783](https://github.com/jenarvaezg/worthline/issues/783):

- cero red externa y cero escrituras en el GET;
- un solo `openStore` por request ([#787](https://github.com/jenarvaezg/worthline/issues/787));
- refresh/sync únicamente en cron o acción explícita ([#788](https://github.com/jenarvaezg/worthline/issues/788));
- sólo rango activo en el HTML inicial ([#789](https://github.com/jenarvaezg/worthline/issues/789));
- CPI deduplicado/cacheado ([#790](https://github.com/jenarvaezg/worthline/issues/790));
- bulk reads para operaciones, posiciones, deudas y freshness.

Aceptación: además de bajar el ceiling `dashboardLoad`, un test debe demostrar que el
GET no invoca adaptadores externos ni mutaciones.

### P0 — Introducir una capa de comandos de aplicación

Las fronteras de paquetes son buenas, pero workflows completos se acumulan en
`dated-fact-seams.ts`, `patrimonio/actions.ts`, `workspace-store.ts` y
`liability-store.ts`. El corte no debe ser por tamaño, sino por unidad de negocio:

```text
Server Action / API
  -> comando tipado + autorización
    -> Unit of Work
      -> repositorios
      -> dominio puro
      -> RipplePlan
      -> audit/outbox
```

Primer tracer bullet: `ApplyDatedFactsBatch`, compartido por inversión, deuda,
vivienda e ingesta histórica. Una mutación debe tener una sola transacción, un solo
plan de ripple y un resultado tipado. De Sure conviene copiar el namespacing por
capacidad; no sus callbacks Active Record ni la proliferación de concerns.

### P0 — Cola durable ligera, sin convertir Redis en requisito

Una tabla de control plane con `kind`, `dedupe_key`, estado, intentos, lease, progreso
y último error basta a escala familiar. Debe ejecutar refresh de precios, sync de
fuentes, captura diaria, backfills e ingesta documental. Esto ofrece las ventajas
operativas de Sidekiq sin romper el modo local sencillo.

### P1 — SDK de conectores y suite de conformidad

Formalizar un puerto con capabilities, cursor, fetch, normalize, preview/reconcile,
apply y disconnect. Cada adaptador debe superar tests comunes de idempotencia,
duplicados, retries, freshness, unlink y atomicidad. Sure demuestra el valor del
catálogo y también el coste de replicar modelos/rutas por proveedor; su propio
generador está desalineado en [#2546](https://github.com/we-promise/sure/issues/2546).

Prioridad razonable: import universal robusto, IBKR y agregación bancaria europea,
antes que sumar exchanges uno a uno.

### P1 — Read model revisionado

No copiar la materialización diaria completa de Sure. Tras hacer el GET read-only,
medir un cache/read model de celdas por `(workspace, scope, revision, range, framing)`.
La revisión cambia atómicamente con cada mutación/ripple; nunca se sirve una cifra
financiera sólo porque un TTL no haya vencido.

### P1 — Autorización no omisible y contratos compartidos

RSC, REST, MCP y un futuro cliente móvil deben consumir las mismas queries y comandos.
Los repositorios de API deben nacer ya ligados a workspace/principal. Sure enseña el
riesgo de añadir autorización en cada endpoint: mantiene issues de bypass en holdings,
imports, trades, bulk updates y reports.

### P2 — Convertir «Libro mayor» en infraestructura

Completar [#825](https://github.com/jenarvaezg/worthline/issues/825) y
[#828](https://github.com/jenarvaezg/worthline/issues/828) con primitivas tokenizadas,
catálogo renderizable, capturas Playwright, a11y y lint de tokens. Esto dará más acabado
que seguir rediseñando páginas aisladas.

### P2 — Distribución y observabilidad

- imagen Docker oficial y camino one-click privado;
- estado e historial de jobs/conectores visible;
- métricas opt-in privacy-safe de duración, errores y queries, nunca nombres o importes;
- test de upgrade/migración desde la última release con una base poblada.

## Features que sí encajan

1. **Inbox de sincronización/reconciliación:** nuevos, modificados, dudosos y omitidos
   antes de aplicar; extensión natural de preview→confirm.
2. **Salud e historial de conectores:** último éxito, error, próxima ejecución,
   entidades importadas y reintento; alimenta [#654](https://github.com/jenarvaezg/worthline/issues/654).
3. **API pública y tokens personales**, con permisos por workspace y contract tests.
4. **Roles read-only por workspace**, aprovechando la separación grant/member existente.
5. **Companion móvil** sólo después de estabilizar comandos/API; primero lectura y
   captura/importación, no una segunda aplicación completa.
6. **`occurredAt` y orden externo** para operaciones/importaciones intradía antes de
   que los conectores vuelvan costoso añadirlo.
7. **Provenance/replay de importación:** qué run/cursor originó cada hecho, diff y
   rollback selectivo, especialmente valioso para la ingesta histórica asistida.
8. **Multidivisa diseñada para fallar honestamente**, sólo tras definir FX fechado,
   fuente, cobertura y ausencia de tipo; nunca fallback 1:1 como el denunciado en
   [Sure #2417](https://github.com/we-promise/sure/issues/2417).

## Features que no conviene copiar ahora

- presupuestos, categorías de gasto, merchants y reglas: crean otra aplicación y
  diluyen «Evoluciona tu Excel patrimonial»;
- Redis/Sidekiq obligatorio en local;
- materialización diaria indiscriminada de cada holding;
- app móvil antes de disponer de comandos/API estables;
- cientos de clases casi duplicadas por proveedor;
- herramientas mutantes del asistente sin preview;
- multidivisa improvisada.

## Secuencia propuesta

1. Rendimiento P0: GET puro, un store, lazy ranges y bulk reads.
2. Capa de comandos + `ApplyDatedFactsBatch`.
3. Cola durable y sync observable.
4. SDK de conectores + import/IBKR/Open Banking.
5. «Libro mayor» ejecutable + API común.
6. Docker/one-click, observabilidad y después companion móvil.

## Posicionamiento resultante

> El sistema patrimonial privado que reconstruye y explica tu historia financiera,
> sabe qué cifras son fiables, modela vivienda, deuda e inversión con rigor y deja
> que humanos y agentes trabajen sobre la misma verdad.

Sure gana hoy en amplitud, conectividad, operación y distribución. Worthline puede
ganar en profundidad patrimonial, integridad temporal, privacidad, transparencia y
asistencia segura. Esa diferencia es más defendible que intentar igualar su catálogo
de pantallas.
